/**
 * Hono mpp-session: voucher state (amount, signature, payer) must come only
 * from a credential mppx has actually verified (issue #388). Before this fix,
 * the Payment header was parsed and its signature/payer committed to session
 * state *before* mppx.channel() verified anything, so a crafted, unverified
 * header could poison the value handleDelete/flagOrphan later use to close
 * the channel or report the payer.
 *
 * This file mocks '@stellar/mpp/channel/server' the same way as
 * hono-orphan-close.test.ts, and additionally mocks '../mppCompatibility.js'
 * to capture the `commit` callback that onVerifiedCredential wraps a channel
 * method's `verify` with — commit is the ONLY thing that may write voucher
 * state, and in the real code path it is only ever invoked by
 * onVerifiedCredential after mppx.channel()'s real verify has resolved. This
 * lets the test simulate "a credential mppx verified" (call commit) versus
 * "a credential mppx rejected" (never call commit) without needing to drive
 * a full signed mppx challenge/response over HTTP.
 */

import { mock, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { Keypair } from '@stellar/stellar-sdk'
import type { RouteDockManifest } from '../../types.js'

const payeeKeypair = Keypair.random()
const commitKeypair = Keypair.random()
const payerKeypair = Keypair.random()

const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const CHANNEL_CONTRACT = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'

let closeCalls: Array<{ amount: bigint; signature: Uint8Array }> = []

mock.module('@stellar/mpp/channel/server', {
  namedExports: {
    Store: {
      memory: () => {
        const m = new Map<string, unknown>()
        return {
          async get(k: string) { return m.get(k) },
          async put(k: string, v: unknown) { m.set(k, v) },
          async delete(k: string) { m.delete(k) },
          update(k: string, fn: (v: unknown) => unknown) { m.set(k, fn(m.get(k))) },
        }
      },
    },
    close: async (opts: { amount: bigint; signature: Uint8Array }) => {
      closeCalls.push({ amount: opts.amount, signature: opts.signature })
      return 'mock-close-tx-hash'
    },
    stellar: () => [],
  },
})

const actualMppxServer = await import('mppx/server')
mock.module('mppx/server', {
  namedExports: {
    ...actualMppxServer,
    Mppx: {
      create: () => ({
        channel: () => async () => ({ status: 200 }),
      }),
    },
  },
})

const actualCompat = await import('../mppCompatibility.js')
type Commit = (credential: { payload?: unknown; source?: string }) => void | Promise<void>
let lastCommit: Commit | null = null
mock.module('../mppCompatibility.js', {
  namedExports: {
    channelAuthorizer: actualCompat.channelAuthorizer,
    withTypedChannelErrors: actualCompat.withTypedChannelErrors,
    formatMppError: actualCompat.formatMppError,
    onVerifiedCredential: (method: unknown, commit: Commit) => {
      lastCommit = commit
      return method
    },
  },
})

const { routedockHono } = await import('../hono.js')

const manifest: RouteDockManifest = {
  routedock: '1.0',
  name: 'Test Service',
  description: 'Unit test provider',
  modes: ['mpp-session'],
  network: 'testnet',
  asset: 'USDC',
  asset_contract: ASSET_CONTRACT,
  payee: payeeKeypair.publicKey(),
  pricing: {
    'mpp-session': {
      rate: '0.0001',
      per: 'voucher',
      channel_factory: CHANNEL_CONTRACT,
      min_deposit: '0.10',
      refund_waiting_period_ledgers: 17280,
    },
  },
  endpoints: { price: { method: 'GET', path: '/price' } },
  tags: ['test'],
}

/**
 * Builds a fresh routedockHono app and returns it along with the `commit`
 * callback that *this specific instance* registered with onVerifiedCredential
 * (mocked module-wide, so we must capture it immediately after construction,
 * before any other test's app-building can reassign it).
 */
function buildApp(handlers: {
  onSessionOpen?: (channelId: string, payer: string | null) => Promise<void>
  onVoucher?: (channelId: string, voucherIndex: number, cumulativeAmount: string, signature: string) => Promise<void>
  onOrphaned?: (channelId: string, info: { cumulativeAmount: string; lastSignature: string; voucherCount: number; reason: string }) => Promise<void>
  idleTimeoutMs?: number
  sessionStore?: Parameters<typeof routedockHono>[0]['sessionStore']
}): { app: Hono; commit: Commit } {
  closeCalls = []
  const app = new Hono()
  const opts: Parameters<typeof routedockHono>[0] = {
    asset: 'USDC',
    assetContract: ASSET_CONTRACT,
    payee: payeeKeypair.publicKey(),
    network: 'testnet',
    payeeSecretKey: payeeKeypair.secret(),
    commitmentPublicKey: commitKeypair.publicKey(),
    manifest,
    modes: ['mpp-session'],
    pricing: { 'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT } },
  }
  if (handlers.onSessionOpen) opts.onSessionOpen = handlers.onSessionOpen
  if (handlers.onVoucher) opts.onVoucher = handlers.onVoucher
  if (handlers.onOrphaned) opts.onOrphaned = handlers.onOrphaned
  if (typeof handlers.idleTimeoutMs === 'number') opts.idleTimeoutMs = handlers.idleTimeoutMs
  if (handlers.sessionStore) opts.sessionStore = handlers.sessionStore

  app.use('*', routedockHono(opts))
  app.get('/price', (c) => {
    return new Promise<Response>((resolve: (r: Response) => void) => {
      if (c.req.raw.signal.aborted) {
        resolve(c.text('aborted', 200))
        return
      }
      c.req.raw.signal.addEventListener('abort', () => {
        resolve(c.text('aborted', 200))
      })
    })
  })
  assert.ok(lastCommit, 'onVerifiedCredential mock should have captured commit during construction')
  const commit = lastCommit!
  return { app, commit }
}

function hexToBytesLocal(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

describe('routedockHono — voucher state only from verified credentials', () => {
  it('pairs each committed amount with its own signature (last onVoucher call reflects the latest pair)', async () => {
    const voucherCalls: Array<{ amount: string; signature: string }> = []
    const { commit } = buildApp({
      onVoucher: async (_id, _idx, amount, signature) => {
        voucherCalls.push({ amount, signature })
      },
    })

    await commit({ payload: { amount: '1000', signature: 'aa'.repeat(32) } })
    await commit({ payload: { amount: '2000', signature: 'bb'.repeat(32) } })

    assert.equal(voucherCalls.length, 2)
    const last = voucherCalls[voucherCalls.length - 1]
    assert.ok(last)
    assert.equal(last.amount, '0.0002000')
    assert.equal(last.signature, 'bb'.repeat(32))
  })

  it('never rolls a committed record back to an earlier, lower amount', async () => {
    const { app, commit } = buildApp({})
    await commit({ payload: { amount: '2000', signature: 'bb'.repeat(32) } })
    // A late/duplicate commit for a lower amount must not replace the record.
    await commit({ payload: { amount: '1000', signature: 'aa'.repeat(32) } })

    const res = await app.request('/price', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: '2000', signature: 'bb'.repeat(32) }),
    })
    assert.equal(res.status, 200)
    assert.equal(closeCalls.length, 1)
    assert.ok(closeCalls[0])
    assert.equal(closeCalls[0].amount, 2000n)
  })

  it('captures the payer only from a credential that was actually committed', async () => {
    const sessionOpens: Array<string | null> = []
    const { commit } = buildApp({
      onSessionOpen: async (_id, payer) => { sessionOpens.push(payer) },
    })

    // No commit call at all simulates a crafted header that failed mppx
    // verification — onVerifiedCredential would never invoke commit for it,
    // so it cannot influence the payer a later, genuinely verified voucher sets.

    await commit({
      payload: { amount: '1000', signature: 'aa'.repeat(32) },
      source: payerKeypair.publicKey(),
    })

    assert.equal(sessionOpens.length, 1)
    assert.equal(sessionOpens[0], payerKeypair.publicKey())

    // A second commit with a different source must not overwrite the payer
    // already locked in from the first verified voucher.
    await commit({
      payload: { amount: '2000', signature: 'bb'.repeat(32) },
      source: Keypair.random().publicKey(),
    })
    assert.equal(sessionOpens.length, 1, 'onSessionOpen must only fire once per session')
  })

  it('ignores an unparseable source and reports a null payer', async () => {
    const sessionOpens: Array<string | null> = []
    const { commit } = buildApp({
      onSessionOpen: async (_id, payer) => { sessionOpens.push(payer) },
    })

    // A source that isn't a valid Stellar address (e.g. a crafted or DID
    // value) must resolve to null, never leak through as a payer.
    await commit({
      payload: { amount: '1000', signature: 'aa'.repeat(32) },
      source: 'did:pkh:eip155:1:0xnotAStellarKey',
    })

    assert.equal(sessionOpens.length, 1)
    assert.equal(sessionOpens[0], null)
  })

  it('a failed verification never calls onVoucher, and a later orphan flag reports the last verified voucher', async () => {
    const voucherCalls: number[] = []
    let orphanInfo: { cumulativeAmount: string; lastSignature: string } | undefined
    const { commit } = buildApp({
      idleTimeoutMs: 30,
      onVoucher: async () => { voucherCalls.push(1) },
      onOrphaned: async (_id, info) => { orphanInfo = info },
    })

    // One genuinely verified voucher.
    await commit({ payload: { amount: '1000', signature: 'aa'.repeat(32) } })
    assert.equal(voucherCalls.length, 1)

    // A later credential fails mppx verification — onVerifiedCredential never
    // calls commit for it (see mppCompatibility.test.ts), so it must not be
    // reflected here. Simulated simply by not calling `commit` again.

    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(voucherCalls.length, 1, 'onVoucher must not have fired again for the failed verification')
    assert.equal(orphanInfo?.cumulativeAmount, '0.0001000')
    assert.equal(orphanInfo?.lastSignature, 'aa'.repeat(32))
  })

  it('DELETE closes with the committed record’s amount and signature, not an arbitrary client-supplied one', async () => {
    const { app, commit } = buildApp({})
    await commit({ payload: { amount: '5000', signature: 'ff'.repeat(32) } })

    const res = await app.request('/price', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: '5000', signature: 'ff'.repeat(32) }),
    })
    assert.equal(res.status, 200)
    assert.equal(closeCalls.length, 1)
    assert.ok(closeCalls[0])
      assert.equal(closeCalls[0].amount, 5000n)
    assert.deepEqual(closeCalls[0].signature, hexToBytesLocal('ff'.repeat(32)))
  })

  it('a DELETE with no committed record and no matching client signature never closes', async () => {
    const { app } = buildApp({})
    // Nothing was ever committed (verification never succeeded) — a bare
    // client-supplied body with an amount of 0 must not trigger a close.
    const res = await app.request('/price', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(res.status, 200)
    assert.equal(closeCalls.length, 0)
    const json = await res.json() as { closeTxHash: unknown }
    assert.equal(json.closeTxHash, null)
  })

  it('persists voucherCount and sessionOpened across rebuilds with a shared Store (issue #556)', async () => {
    const storeMap = new Map<string, unknown>()
    const sharedStore = {
      async get(k: string) { return storeMap.get(k) },
      async put(k: string, v: unknown) { storeMap.set(k, v) },
      async delete(k: string) { storeMap.delete(k) },
      update(k: string, fn: (v: unknown) => unknown) { storeMap.set(k, fn(storeMap.get(k))) },
    }

    const sessionOpens: string[] = []
    const voucherCalls: Array<{ voucherIndex: number; amount: string }> = []

    // 1. Build first instance on sharedStore and commit N (3) vouchers
    const instance1 = buildApp({
      sessionStore: sharedStore,
      onSessionOpen: async (_channelId, payer) => { sessionOpens.push(payer ?? '') },
      onVoucher: async (_id, idx, amount) => { voucherCalls.push({ voucherIndex: idx, amount }) },
    })

    await instance1.commit({
      payload: { amount: '1000', signature: '11'.repeat(32) },
      source: payerKeypair.publicKey(),
    })
    await instance1.commit({ payload: { amount: '2000', signature: '22'.repeat(32) } })
    await instance1.commit({ payload: { amount: '3000', signature: '33'.repeat(32) } })

    assert.equal(sessionOpens.length, 1, 'onSessionOpen should fire on first voucher')
    assert.equal(voucherCalls.length, 3)
    assert.equal(voucherCalls[2]?.voucherIndex, 3)

    // 2. Build second routedockHono on the SAME store (simulating DO eviction and rebuild)
    const instance2 = buildApp({
      sessionStore: sharedStore,
      onSessionOpen: async (_channelId, payer) => { sessionOpens.push(payer ?? '') },
      onVoucher: async (_id, idx, amount) => { voucherCalls.push({ voucherIndex: idx, amount }) },
    })

    // Commit voucher N+1 (4th voucher)
    await instance2.commit({ payload: { amount: '4000', signature: '44'.repeat(32) } })

    // onSessionOpen must NOT fire again (must have fired exactly once overall)
    assert.equal(sessionOpens.length, 1, 'onSessionOpen must only fire once across DO rebuilds')
    // onVoucher must report index N+1 (4)
    assert.equal(voucherCalls.length, 4)
    assert.equal(voucherCalls[3]?.voucherIndex, 4, 'onVoucher must report index N+1 after rebuild')
    assert.equal(voucherCalls[3]?.amount, '0.0004000')
  })

  it('flagOrphan after a rebuild still calls onOrphaned for an open session (issue #556)', async () => {
    const storeMap = new Map<string, unknown>()
    const sharedStore = {
      async get(k: string) { return storeMap.get(k) },
      async put(k: string, v: unknown) { storeMap.set(k, v) },
      async delete(k: string) { storeMap.delete(k) },
      update(k: string, fn: (v: unknown) => unknown) { storeMap.set(k, fn(storeMap.get(k))) },
    }

    // 1. Build first instance and commit 2 vouchers
    const instance1 = buildApp({ sessionStore: sharedStore })
    await instance1.commit({ payload: { amount: '1000', signature: '11'.repeat(32) } })
    await instance1.commit({ payload: { amount: '2500', signature: '25'.repeat(32) } })

    // 2. Build second instance on the SAME store, with onOrphaned and idleTimeoutMs
    let orphanInfo: { cumulativeAmount: string; lastSignature: string; voucherCount: number; reason: string } | undefined
    let resolveOrphaned!: () => void
    const orphanedPromise = new Promise<void>((resolve) => { resolveOrphaned = resolve })

    const instance2 = buildApp({
      sessionStore: sharedStore,
      idleTimeoutMs: 30,
      onOrphaned: async (_channelId, info) => {
        orphanInfo = info
        resolveOrphaned()
      },
    })

    // Simulate an ongoing in-flight request on instance2 (e.g. streaming or polling)
    const controller = new AbortController()
    const reqPromise = instance2.app.request('/price', {
      method: 'GET',
      signal: controller.signal,
    })

    // Yield to let the request pass through payment middleware and arm the abort guard
    await new Promise((resolve) => setTimeout(resolve, 10))

    // Abort connection mid-stream to trigger armAbortGuard -> flagOrphan('connection-closed')
    controller.abort()
    await reqPromise

    await Promise.race([
      orphanedPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('onOrphaned never fired on rebuilt instance')), 1000)),
    ])

    assert.ok(orphanInfo, 'onOrphaned must be called after rebuild')
    assert.equal(orphanInfo.voucherCount, 2, 'voucherCount must reflect the persisted vouchers')
    assert.equal(orphanInfo.cumulativeAmount, '0.0002500')
    assert.equal(orphanInfo.lastSignature, '25'.repeat(32))
    assert.equal(orphanInfo.reason, 'connection-closed')
  })

  it('handleDelete after a rebuild cleanly settles and deletes persisted session bookkeeping', async () => {
    const storeMap = new Map<string, unknown>()
    const sharedStore = {
      async get(k: string) { return storeMap.get(k) },
      async put(k: string, v: unknown) { storeMap.set(k, v) },
      async delete(k: string) { storeMap.delete(k) },
      update(k: string, fn: (v: unknown) => unknown) { storeMap.set(k, fn(storeMap.get(k))) },
    }

    const instance1 = buildApp({ sessionStore: sharedStore })
    await instance1.commit({ payload: { amount: '5000', signature: '55'.repeat(32) } })

    // Verify record was persisted
    const voucherKey = `routedock:session:voucher:${CHANNEL_CONTRACT}`
    assert.ok(storeMap.has(voucherKey))

    // Build second instance on same store
    const instance2 = buildApp({ sessionStore: sharedStore })

    // DELETE on instance2
    const res = await instance2.app.request('/price', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: '5000', signature: '55'.repeat(32) }),
    })
    assert.equal(res.status, 200)
    assert.equal(closeCalls.length, 1)
    assert.equal(closeCalls[0]?.amount, 5000n)

    // Store record should now be deleted
    assert.equal(storeMap.has(voucherKey), false, 'persisted session record should be deleted on close')
  })
})
