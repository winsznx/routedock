import { mock, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { Keypair } from '@stellar/stellar-sdk'
import type { RouteDockManifest } from '../../types.js'
import type { RouteDockHonoOptions } from '../hono.js'

const payeeKeypair = Keypair.random()
const commitKeypair = Keypair.random()
const payerKeypair = Keypair.random()

const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const CHANNEL_CONTRACT = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'

let settleCalls = 0

mock.module('@x402/stellar/exact/facilitator', {
  namedExports: {
    ExactStellarScheme: class {
      async verify() {
        return { isValid: true }
      }
      async settle() {
        settleCalls++
        return { success: true, transaction: `TX_${settleCalls}` }
      }
    },
  },
})

mock.module('@x402/core/server', {
  namedExports: {
    HTTPFacilitatorClient: class {},
    x402ResourceServer: class {
      register() {}
      async createPaymentRequiredResponse() {
        return { x402Version: 2, accepts: [] }
      }
      async settlePayment() {
        settleCalls++
        return { success: true, transaction: `TX_${settleCalls}` }
      }
    },
  },
})

mock.module('@x402/core/http', {
  namedExports: {
    decodePaymentSignatureHeader: () => ({
      authorization: { credentials: [{ publicKey: payerKeypair.publicKey() }] },
    }),
    encodePaymentRequiredHeader: (value: unknown) => `requirements:${JSON.stringify(value)}`,
    encodePaymentResponseHeader: (value: unknown) => `response:${JSON.stringify(value)}`,
  },
})

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
    close: async () => 'CLOSE_TX',
    stellar: () => [],
  },
})

const actualMppxServer = await import('mppx/server')
type Commit = (credential: { payload?: unknown; source?: string }) => void | Promise<void>
let capturedCommit: Commit | null = null
let sessionCredential: { payload?: unknown; source?: string } | null = null

mock.module('mppx/server', {
  namedExports: {
    ...actualMppxServer,
    Mppx: {
      create: () => ({
        channel: () => async () => {
          if (sessionCredential) await capturedCommit!(sessionCredential)
          return { status: 200 }
        },
      }),
    },
  },
})

const actualCompat = await import('../mppCompatibility.js')
mock.module('../mppCompatibility.js', {
  namedExports: {
    channelAuthorizer: actualCompat.channelAuthorizer,
    withTypedChannelErrors: actualCompat.withTypedChannelErrors,
    formatMppError: actualCompat.formatMppError,
    onVerifiedCredential: (method: unknown, commit: Commit) => {
      capturedCommit = commit
      return method
    },
  },
})

const { routedockHono } = await import('../hono.js')

const manifestFor = (modes: RouteDockManifest['modes']): RouteDockManifest => ({
  routedock: '1.0',
  name: 'Background Callback Test',
  description: 'Unit test provider',
  modes,
  network: 'testnet',
  asset: 'USDC',
  asset_contract: ASSET_CONTRACT,
  payee: payeeKeypair.publicKey(),
  pricing: {
    x402: { amount: '0.001', per: 'request' },
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
})

function fakeCtx() {
  const promises: Promise<unknown>[] = []
  return {
    promises,
    waitUntil(promise: Promise<unknown>) { promises.push(promise) },
    passThroughOnException() {},
  }
}

function makeX402App(overrides: Partial<RouteDockHonoOptions> = {}): Hono {
  const app = new Hono()
  app.use(
    '*',
    routedockHono({
      modes: ['x402'],
      pricing: { x402: '0.001' },
      asset: 'USDC',
      assetContract: ASSET_CONTRACT,
      payee: payeeKeypair.publicKey(),
      network: 'testnet',
      payeeSecretKey: payeeKeypair.secret(),
      manifest: manifestFor(['x402']),
      ...overrides,
    }),
  )
  app.get('/price', (c) => c.json({ ok: true }))
  return app
}

function makeSessionApp(overrides: Partial<RouteDockHonoOptions> = {}): Hono {
  const app = new Hono()
  app.use(
    '*',
    routedockHono({
      modes: ['mpp-session'],
      pricing: { 'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT } },
      asset: 'USDC',
      assetContract: ASSET_CONTRACT,
      payee: payeeKeypair.publicKey(),
      network: 'testnet',
      payeeSecretKey: payeeKeypair.secret(),
      commitmentPublicKey: commitKeypair.publicKey(),
      manifest: manifestFor(['mpp-session']),
      ...overrides,
    }),
  )
  app.get('/price', (c) => c.json({ ok: true }))
  return app
}

describe('routedockHono background callbacks', () => {
  it('hands each x402 onSettled promise to that request executionCtx', async () => {
    settleCalls = 0
    const settled: string[] = []
    const app = makeX402App({
      onSettled: async (txHash) => { settled.push(txHash) },
    })

    const ctx1 = fakeCtx()
    const ctx2 = fakeCtx()
    const first = await app.request(
      '/price',
      { headers: { 'payment-signature': 'first' } },
      undefined,
      ctx1 as never,
    )
    const second = await app.request(
      '/price',
      { headers: { 'payment-signature': 'second' } },
      undefined,
      ctx2 as never,
    )

    assert.equal(first.status, 200)
    assert.equal(second.status, 200)
    assert.equal(ctx1.promises.length, 1)
    assert.equal(ctx2.promises.length, 1)
    assert.notEqual(ctx1.promises[0], ctx2.promises[0])

    await Promise.all(ctx1.promises)
    await Promise.all(ctx2.promises)
    assert.deepEqual(settled, ['TX_1', 'TX_2'])
  })

  it('prefers an explicit waitUntil over executionCtx', async () => {
    settleCalls = 0
    const explicit: Promise<unknown>[] = []
    const ctx = fakeCtx()
    const app = makeX402App({
      waitUntil: (p) => { explicit.push(p) },
      onSettled: async () => {},
    })

    const res = await app.request(
      '/price',
      { headers: { 'payment-signature': 'explicit' } },
      undefined,
      ctx as never,
    )
    assert.equal(res.status, 200)
    assert.equal(explicit.length, 1)
    assert.equal(ctx.promises.length, 0)
    await Promise.all(explicit)
  })

  it('leaves callbacks floating without throwing when there is no executionCtx', async () => {
    settleCalls = 0
    const settled: string[] = []
    const app = makeX402App({
      onSettled: async (txHash) => { settled.push(txHash) },
    })

    const res = await app.request('/price', { headers: { 'payment-signature': 'node' } })
    assert.equal(res.status, 200)
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(settled, ['TX_1'])
  })

  it('runs first-voucher onVoucher after onSessionOpen resolves and waits on both', async () => {
    const events: string[] = []
    let releaseOpen!: () => void
    const openGate = new Promise<void>((resolve) => { releaseOpen = resolve })

    const app = makeSessionApp({
      onSessionOpen: async () => {
        events.push('open-start')
        await openGate
        events.push('open-end')
      },
      onVoucher: async () => { events.push('voucher') },
    })
    assert.ok(capturedCommit)

    sessionCredential = {
      payload: { amount: '1000', signature: 'aa'.repeat(32) },
      source: payerKeypair.publicKey(),
    }
    const ctx = fakeCtx()
    const res = await app.request(
      '/price',
      { headers: { authorization: 'Payment credential' } },
      undefined,
      ctx as never,
    )
    sessionCredential = null

    assert.equal(res.status, 200)
    assert.equal(ctx.promises.length, 2)
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(events, ['open-start'])

    releaseOpen()
    await Promise.all(ctx.promises)
    assert.deepEqual(events, ['open-start', 'open-end', 'voucher'])
  })
})
