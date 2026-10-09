import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Hono } from 'hono'
import { Keypair } from '@stellar/stellar-sdk'
import { routedockHono, type RouteDockHonoOptions } from '../hono.js'
import type { RouteDockManifest } from '../../types.js'
import { InMemorySeenTxStore, paymentIdempotencyKey } from '../SeenTxStore.js'
import { usdcToStroops } from '../../internal/usdc.js'

// Generate fresh keypairs — avoids hardcoding secrets while keeping tests self-contained
const payeeKeypair = Keypair.random()
const commitKeypair = Keypair.random()

const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const CHANNEL_CONTRACT = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'

const manifest: RouteDockManifest = {
  routedock: '1.0',
  name: 'Test Service',
  description: 'Unit test provider',
  modes: ['x402', 'mpp-charge', 'mpp-session'],
  network: 'testnet',
  asset: 'USDC',
  asset_contract: ASSET_CONTRACT,
  payee: payeeKeypair.publicKey(),
  pricing: {
    x402: { amount: '0.001', per: 'request' },
    'mpp-charge': { amount: '0.0008', per: 'request' },
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

const BASE_OPTS = {
  asset: 'USDC',
  assetContract: ASSET_CONTRACT,
  payee: payeeKeypair.publicKey(),
  network: 'testnet' as const,
  payeeSecretKey: payeeKeypair.secret(),
  commitmentPublicKey: commitKeypair.publicKey(),
  manifest,
}

function makeApp(overrides: Partial<RouteDockHonoOptions> = {}) {
  const app = new Hono()
  app.use(
    '*',
    routedockHono({
      ...BASE_OPTS,
      modes: ['x402', 'mpp-charge', 'mpp-session'],
      pricing: {
        x402: '0.001',
        'mpp-charge': '0.0008',
        'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT },
      },
      ...overrides,
    }),
  )
  app.get('/price', (c) => c.json({ price: '42' }))
  return app
}

describe('routedockHono — manifest endpoint', () => {
  it('serves /.well-known/routedock.json', async () => {
    const app = makeApp({ modes: [] as ('x402' | 'mpp-charge' | 'mpp-session')[], pricing: {} })
    const res = await app.request('/.well-known/routedock.json')
    assert.equal(res.status, 200)
    const body = await res.json() as { name: string }
    assert.equal(body.name, manifest.name)
  })

  it('passes through when no modes are configured', async () => {
    const app = makeApp({ modes: [], pricing: {} })
    const res = await app.request('/price')
    assert.equal(res.status, 200)
  })
})

describe('routedockHono — x402 flow', () => {
  it('returns 402 with X-Payment-Requirements when no payment header', async () => {
    const app = makeApp({
      modes: ['x402'],
      pricing: { x402: '0.001' },
    })
    const res = await app.request('/price', { method: 'GET' })
    assert.equal(res.status, 402)
    assert.ok(
      res.headers.get('x-payment-requirements'),
      'expected X-Payment-Requirements header',
    )
    const body = await res.json() as { error: string }
    assert.equal(body.error, 'Payment Required')
  })

  it('routes to x402 handler when x-preferred-mode: x402 header is set', async () => {
    const app = makeApp({
      modes: ['x402', 'mpp-charge'],
      pricing: { x402: '0.001', 'mpp-charge': '0.0008' },
    })
    const res = await app.request('/price', {
      headers: { 'x-preferred-mode': 'x402' },
    })
    assert.equal(res.status, 402)
    assert.ok(res.headers.get('x-payment-requirements'))
  })
})

describe('routedockHono — mpp-charge flow', () => {
  it('returns 402 challenge when no authorization header', async () => {
    const app = makeApp({
      modes: ['mpp-charge'],
      pricing: { 'mpp-charge': '0.0008' },
    })
    const res = await app.request('/price', { method: 'GET' })
    assert.equal(res.status, 402)
  })
})

describe('routedockHono — mpp-session flow', () => {
  it('returns 402 challenge when no authorization header', async () => {
    const app = makeApp({
      modes: ['mpp-session'],
      pricing: {
        'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT },
      },
    })
    const res = await app.request('/price', { method: 'GET' })
    assert.equal(res.status, 402)
  })

  it('rejects unauthenticated DELETE with no prior vouchers', async () => {
    const app = makeApp({
      modes: ['mpp-session'],
      pricing: {
        'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT },
      },
    })
    const res = await app.request('/price', { method: 'DELETE' })
    assert.equal(res.status, 402)
  })
})

describe('routedockHono — mpp-session-ws flow', () => {
  it('returns 402 challenge when no authorization header', async () => {
    const app = makeApp({
      modes: ['mpp-session-ws'],
      pricing: {
        'mpp-session-ws': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT },
      },
    })
    const res = await app.request('/price', { method: 'GET' })
    assert.equal(res.status, 402)
  })

  it('rejects unauthenticated DELETE with no prior vouchers', async () => {
    const app = makeApp({
      modes: ['mpp-session-ws'],
      pricing: {
        'mpp-session-ws': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT },
      },
    })
    const res = await app.request('/price', { method: 'DELETE' })
    assert.equal(res.status, 402)
  })
})

describe('routedockHono — constructor validation', () => {
  it('throws when mpp-session mode is enabled without commitmentPublicKey', () => {
    const { commitmentPublicKey: _ignored, ...withoutCommitment } = BASE_OPTS
    assert.throws(
      () =>
        routedockHono({
          ...withoutCommitment,
          modes: ['mpp-session'],
          pricing: {
            'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT },
          },
        }),
      /commitmentPublicKey/,
    )
  })
})

describe('routedockHono — settlement idempotency', () => {
  const X402_AMOUNT = String(usdcToStroops('0.001'))

  it('replays cached settlement on duplicate payment-signature header', async () => {
    const seenStore = new InMemorySeenTxStore()
    const settled: string[] = []

    const key = await paymentIdempotencyKey(
      (n) => (n === 'payment-signature' ? 'SIG' : undefined),
      {
        method: 'GET',
        path: '/price',
        amount: X402_AMOUNT,
        payTo: payeeKeypair.publicKey(),
      },
    )
    assert.ok(key)
    await seenStore.set(key, {
      txHash: 'CACHED_TX_HASH',
      headers: { 'X-Payment-Response': 'cached-response' },
      createdAt: Date.now(),
    })

    const app = makeApp({
      modes: ['x402'],
      pricing: { x402: '0.001' },
      seenTxStore: seenStore,
      onSettled: async (txHash: string) => { settled.push(txHash) },
    })

    const res = await app.request('/price', {
      headers: { 'payment-signature': 'SIG' },
    })
    assert.equal(res.status, 200)
    const data = (await res.json()) as { price: string }
    assert.equal(data.price, '42')
    assert.equal(res.headers.get('x-payment-response'), 'cached-response')

    await new Promise((r) => setImmediate(r))
    assert.equal(settled.length, 0)
  })

  it('rejects the second replay with 402 and does not run the route handler again', async () => {
    const seenStore = new InMemorySeenTxStore({ warn: false })
    let handlerRuns = 0
    const app = new Hono()
    app.use(
      '*',
      routedockHono({
        ...BASE_OPTS,
        modes: ['x402'],
        pricing: { x402: '0.001' },
        seenTxStore: seenStore,
      }),
    )
    app.get('/price', (c) => {
      handlerRuns++
      return c.json({ price: '42' })
    })

    const key = await paymentIdempotencyKey(
      (n) => (n === 'payment-signature' ? 'SIG' : undefined),
      { method: 'GET', path: '/price', amount: X402_AMOUNT, payTo: payeeKeypair.publicKey() },
    )
    assert.ok(key)
    await seenStore.set(key, { txHash: 'TX', createdAt: Date.now() })

    const first = await app.request('/price', { headers: { 'payment-signature': 'SIG' } })
    assert.equal(first.status, 200)
    const second = await app.request('/price', { headers: { 'payment-signature': 'SIG' } })
    assert.equal(second.status, 402)
    const body = (await second.json()) as { error: string }
    assert.equal(body.error, 'Payment already used')
    assert.equal(handlerRuns, 1)
  })

  it('rejects a settlement older than the replay window', async () => {
    const seenStore = new InMemorySeenTxStore({ warn: false })
    const app = makeApp({
      modes: ['x402'],
      pricing: { x402: '0.001' },
      seenTxStore: seenStore,
    })
    const key = await paymentIdempotencyKey(
      (n) => (n === 'payment-signature' ? 'SIG' : undefined),
      { method: 'GET', path: '/price', amount: X402_AMOUNT, payTo: payeeKeypair.publicKey() },
    )
    assert.ok(key)
    await seenStore.set(key, {
      txHash: 'TX',
      headers: { 'X-Payment-Response': 'cached-response' },
      createdAt: Date.now() - 61_000,
    })

    const res = await app.request('/price', { headers: { 'payment-signature': 'SIG' } })
    assert.equal(res.status, 402)
  })

  it('does not replay a payment settled on a different route against a shared store', async () => {
    const seenStore = new InMemorySeenTxStore({ warn: false })
    let cheapRuns = 0
    let expensiveRuns = 0
    const app = new Hono()
    app.use(
      '/cheap',
      routedockHono({ ...BASE_OPTS, modes: ['x402'], pricing: { x402: '0.001' }, seenTxStore: seenStore }),
    )
    app.use(
      '/expensive',
      routedockHono({ ...BASE_OPTS, modes: ['x402'], pricing: { x402: '5.00' }, seenTxStore: seenStore }),
    )
    app.get('/cheap', (c) => {
      cheapRuns++
      return c.json({ price: 'cheap' })
    })
    app.get('/expensive', (c) => {
      expensiveRuns++
      return c.json({ price: 'expensive' })
    })

    const cheapKey = await paymentIdempotencyKey(
      (n) => (n === 'payment-signature' ? 'SIG' : undefined),
      { method: 'GET', path: '/cheap', amount: X402_AMOUNT, payTo: payeeKeypair.publicKey() },
    )
    assert.ok(cheapKey)
    await seenStore.set(cheapKey, { txHash: 'TX', createdAt: Date.now() })

    // Request /expensive before /cheap: the reverse order hides a header-only
    // key behind the replay cap instead of the route scope.
    const expensiveRes = await app.request('/expensive', { headers: { 'payment-signature': 'SIG' } })
    assert.notEqual(expensiveRes.status, 200)
    assert.equal(expensiveRuns, 0)

    const cheapRes = await app.request('/cheap', { headers: { 'payment-signature': 'SIG' } })
    assert.equal(cheapRes.status, 200)
    assert.equal(cheapRuns, 1)
  })

  it('replays cached settlement on duplicate authorization header (mpp-charge)', async () => {
    const seenStore = new InMemorySeenTxStore()
    const settled: string[] = []

    const key = await paymentIdempotencyKey(
      (n) => (n === 'authorization' ? 'Payment test-credential' : undefined),
      {
        method: 'GET',
        path: '/price',
        amount: '0.0008',
        payTo: payeeKeypair.publicKey(),
      },
    )
    assert.ok(key)
    await seenStore.set(key, {
      txHash: 'CACHED_TX_HASH',
      headers: { 'X-Payment-Response': 'cached-response' },
      createdAt: Date.now(),
    })

    const app = makeApp({
      modes: ['mpp-charge'],
      pricing: { 'mpp-charge': '0.0008' },
      seenTxStore: seenStore,
      onSettled: async (txHash: string) => { settled.push(txHash) },
    })

    const res = await app.request('/price', {
      headers: { authorization: 'Payment test-credential' },
    })
    assert.equal(res.status, 200)
    const data = (await res.json()) as { price: string }
    assert.equal(data.price, '42')
    assert.equal(res.headers.get('x-payment-response'), 'cached-response')

    await new Promise((r) => setImmediate(r))
    assert.equal(settled.length, 0)

    // A second replay of the same mpp-charge credential is spent.
    const second = await app.request('/price', {
      headers: { authorization: 'Payment test-credential' },
    })
    assert.equal(second.status, 402)
  })
})

