import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  InMemorySeenTxStore,
  paymentIdempotencyKey,
  checkSettlementReplay,
  SETTLEMENT_REPLAY_WINDOW_MS,
  MAX_SETTLEMENT_REPLAYS,
  type SettlementScope,
  type SettlementRecord,
  type SeenTxStore,
} from '../SeenTxStore.js'

const SCOPE: SettlementScope = {
  method: 'GET',
  path: '/price',
  amount: '10000',
  payTo: 'GPAYEE',
}

describe('InMemorySeenTxStore', () => {
  it('returns undefined for unseen keys', () => {
    const store = new InMemorySeenTxStore({ warn: false })
    assert.equal(store.get('nope'), undefined)
  })

  it('stores and returns a settlement record', () => {
    const store = new InMemorySeenTxStore({ warn: false })
    const record = {
      txHash: 'tx_abc',
      headers: { 'X-Payment-Response': 'r' },
      createdAt: 1_700_000_000_000,
    }
    store.set('k1', record)
    assert.deepEqual(store.get('k1'), record)
  })

  it('evicts the oldest entry past maxEntries (FIFO)', () => {
    const store = new InMemorySeenTxStore({ maxEntries: 2, warn: false })
    store.set('a', { txHash: 'a', createdAt: Date.now() })
    store.set('b', { txHash: 'b', createdAt: Date.now() })
    store.set('c', { txHash: 'c', createdAt: Date.now() }) // evicts 'a'
    assert.equal(store.get('a'), undefined)
    assert.equal(store.get('b')?.txHash, 'b')
    assert.equal(store.get('c')?.txHash, 'c')
  })

  it('overwriting a key does not grow the eviction queue', () => {
    const store = new InMemorySeenTxStore({ maxEntries: 2, warn: false })
    store.set('a', { txHash: 'a1', createdAt: Date.now() })
    store.set('a', { txHash: 'a2', createdAt: Date.now() })
    store.set('b', { txHash: 'b', createdAt: Date.now() })
    // 'a' was overwritten, not re-queued, so it must survive.
    assert.equal(store.get('a')?.txHash, 'a2')
    assert.equal(store.get('b')?.txHash, 'b')
  })

  it('evicts the replay count together with the record', () => {
    const store = new InMemorySeenTxStore({ maxEntries: 1, warn: false })
    store.set('a', { txHash: 'a', createdAt: Date.now() })
    store.set('b', { txHash: 'b', createdAt: Date.now() }) // evicts 'a'
    assert.equal(store.claimReplay('a'), Number.POSITIVE_INFINITY)
    assert.equal(store.claimReplay('b'), 1)
  })

  it('emits a warning on Cloudflare Workers when warn is not false', () => {
    const warnings: string[] = []
    const origWarn = console.warn
    console.warn = (msg: string) => warnings.push(msg)
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Cloudflare-Workers' },
      configurable: true,
    })
    try {
      new InMemorySeenTxStore()
      assert.ok(warnings.length > 0)
      assert.ok(warnings[0]!.includes('SeenTxStore'))
    } finally {
      console.warn = origWarn
      Object.defineProperty(globalThis, 'navigator', {
        value: undefined,
        configurable: true,
      })
    }
  })

  it('does not warn on Node (no navigator or non-Workers userAgent)', () => {
    const warnings: string[] = []
    const origWarn = console.warn
    console.warn = (msg: string) => warnings.push(msg)
    Object.defineProperty(globalThis, 'navigator', {
      value: undefined,
      configurable: true,
    })
    try {
      new InMemorySeenTxStore()
      assert.equal(warnings.length, 0)
    } finally {
      console.warn = origWarn
      Object.defineProperty(globalThis, 'navigator', {
        value: undefined,
        configurable: true,
      })
    }
  })

  it('suppresses warning when warn: false', () => {
    const warnings: string[] = []
    const origWarn = console.warn
    console.warn = (msg: string) => warnings.push(msg)
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Cloudflare-Workers' },
      configurable: true,
    })
    try {
      new InMemorySeenTxStore({ warn: false })
      assert.equal(warnings.length, 0)
    } finally {
      console.warn = origWarn
      Object.defineProperty(globalThis, 'navigator', {
        value: undefined,
        configurable: true,
      })
    }
  })
})

describe('InMemorySeenTxStore.claimReplay', () => {
  it('increments the replay count and returns Infinity for unknown keys', () => {
    const store = new InMemorySeenTxStore({ warn: false })
    assert.equal(store.claimReplay('missing'), Number.POSITIVE_INFINITY)
    store.set('k', { txHash: 'tx', createdAt: Date.now() })
    assert.equal(store.claimReplay('k'), 1)
    assert.equal(store.claimReplay('k'), 2)
  })
})

describe('paymentIdempotencyKey', () => {
  const key = async (h: Record<string, string>, scope: SettlementScope = SCOPE) =>
    await paymentIdempotencyKey((name) => h[name], scope)

  it('returns null when no payment header is present', async () => {
    assert.equal(await key({ 'content-type': 'application/json' }), null)
  })

  it('keys off payment-signature when present', async () => {
    const result = await key({ 'payment-signature': 'sig' })
    assert.ok(result)
    assert.equal(result!.length, 64)
  })

  it('prefers payment-signature over x-payment and authorization', async () => {
    const result = await key({
      'payment-signature': 'sig',
      'x-payment': 'xp',
      authorization: 'Payment a',
    })
    const sigResult = await key({ 'payment-signature': 'sig' })
    assert.equal(result, sigResult)
  })

  it('falls back to authorization for mpp credentials', async () => {
    const authKey = await key({ authorization: 'Payment credential="abc"' })
    assert.ok(authKey)
    assert.equal(authKey!.length, 64)
  })

  it('yields the same key for a byte-identical retry', async () => {
    const headers = { 'x-payment': 'identical-signed-payment' }
    assert.equal(await key(headers), await key(headers))
  })

  it('changes the key when any scope field changes', async () => {
    const headers = { 'x-payment': 'same-header' }
    const base = await key(headers)
    assert.notEqual(base, await key(headers, { ...SCOPE, method: 'POST' }))
    assert.notEqual(base, await key(headers, { ...SCOPE, path: '/other' }))
    assert.notEqual(base, await key(headers, { ...SCOPE, amount: '20000' }))
    assert.notEqual(base, await key(headers, { ...SCOPE, payTo: 'GOTHERPAYEE' }))
  })
})

describe('checkSettlementReplay', () => {
  it('returns miss for an unknown key', async () => {
    const store = new InMemorySeenTxStore({ warn: false })
    assert.deepEqual(await checkSettlementReplay(store, 'unknown'), { kind: 'miss' })
  })

  it('replays once, then reports spent', async () => {
    const store = new InMemorySeenTxStore({ warn: false })
    const record = { txHash: 'tx', headers: { 'X-Payment-Response': 'r' }, createdAt: Date.now() }
    store.set('k', record)

    assert.deepEqual(await checkSettlementReplay(store, 'k'), { kind: 'replay', record })
    assert.deepEqual(await checkSettlementReplay(store, 'k'), { kind: 'spent' })
  })

  it('reports spent for a record older than the replay window', async () => {
    const store = new InMemorySeenTxStore({ warn: false })
    const now = Date.now()
    store.set('k', { txHash: 'tx', createdAt: now - SETTLEMENT_REPLAY_WINDOW_MS - 1_000 })
    assert.deepEqual(await checkSettlementReplay(store, 'k', now), { kind: 'spent' })
  })

  it('does not consume a replay for an expired record', async () => {
    const store = new InMemorySeenTxStore({ warn: false })
    const now = Date.now()
    store.set('k', { txHash: 'tx', createdAt: now - SETTLEMENT_REPLAY_WINDOW_MS - 1_000 })
    await checkSettlementReplay(store, 'k', now)
    // Counter untouched, so a fresh window would still allow a replay.
    assert.equal(store.claimReplay('k'), 1)
  })

  it('exposes the documented window and limit', () => {
    assert.equal(SETTLEMENT_REPLAY_WINDOW_MS, 60_000)
    assert.equal(MAX_SETTLEMENT_REPLAYS, 1)
  })
})

describe('checkSettlementReplay — custom stores without claimReplay', () => {
  /** A store written against the original two-method (`get`/`set`) contract. */
  function legacyStore(record: SettlementRecord): SeenTxStore {
    return {
      get: () => record,
      set: () => {},
    }
  }

  it('bounds a timestamped replay by the window instead of the count', async () => {
    const now = Date.now()
    const record: SettlementRecord = { txHash: 'tx', createdAt: now }
    const store = legacyStore(record)

    assert.deepEqual(await checkSettlementReplay(store, 'k', now), { kind: 'replay', record })
    // No counter to consume, so a second in-window retry still replays.
    assert.equal((await checkSettlementReplay(store, 'k', now)).kind, 'replay')
  })

  it('reports spent for a legacy record past the window', async () => {
    const now = Date.now()
    const store = legacyStore({ txHash: 'tx', createdAt: now - SETTLEMENT_REPLAY_WINDOW_MS - 1 })
    assert.deepEqual(await checkSettlementReplay(store, 'k', now), { kind: 'spent' })
  })

  it('replays a legacy record with no createdAt, as before the bound existed', async () => {
    const record: SettlementRecord = { txHash: 'tx' }
    const store = legacyStore(record)
    assert.deepEqual(await checkSettlementReplay(store, 'k'), { kind: 'replay', record })
  })
})
