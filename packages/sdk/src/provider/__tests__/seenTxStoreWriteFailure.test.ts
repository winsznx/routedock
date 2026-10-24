/**
 * A failed SeenTxStore.set after on-chain settlement must not fail the request (#326).
 *
 * By the time the idempotency record is written the funds have moved, so the
 * handler logs the failure, reports it through onCallbackError(err,
 * 'seenTxStore.set') and still runs onSettled and the route.
 *
 * Payment libraries are mocked so a settlement can succeed without a chain.
 * This file runs in its own process (node:test), so the real hono.test.ts and
 * express.test.ts are unaffected (same pattern as hono-settle-failure.test.ts).
 */

import { mock, describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import express from 'express'
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express'
import { Hono } from 'hono'
import { Keypair } from '@stellar/stellar-sdk'
import type { RouteDockManifest } from '../../types.js'
import type { SeenTxStore } from '../SeenTxStore.js'

const payeeKeypair = Keypair.random()
const commitKeypair = Keypair.random()

const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const CHANNEL_CONTRACT = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'
const PAYER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const RECEIPT_REFERENCE = 'RECEIPT_REF_123'

let settleBehaviour: 'succeed' | 'reject' = 'succeed'
let settleCalls = 0

mock.module('@x402/stellar/exact/facilitator', {
  namedExports: {
    ExactStellarScheme: class {
      async verify() {
        return { isValid: true }
      }
      async settle() {
        settleCalls++
        if (settleBehaviour === 'reject') throw new Error('settle exploded')
        return { success: true, transaction: 'SETTLED_TX', network: 'stellar:testnet' }
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
        return { success: true, transaction: 'SETTLED_TX', network: 'stellar:testnet' }
      }
    },
  },
})

mock.module('@x402/core/http', {
  namedExports: {
    decodePaymentSignatureHeader: () => ({
      authorization: { credentials: [{ publicKey: PAYER }] },
    }),
    encodePaymentRequiredHeader: (value: unknown) => `requirements:${JSON.stringify(value)}`,
    encodePaymentResponseHeader: (value: unknown) => `response:${JSON.stringify(value)}`,
  },
})

const RECEIPT_HEADER = Buffer.from(JSON.stringify({ reference: RECEIPT_REFERENCE })).toString('base64')

mock.module('mppx/server', {
  namedExports: {
    // Every name the real module exports must be present or importing modules
    // fail to link (see hono-mpp-session-ws.test.ts).
    Expires: {},
    Store: {},
    Request: { fromNodeListener: () => new Request('http://localhost/price') },
    Response: {},
    Transport: {},
    NodeListener: {},
    stripe: {},
    tempo: {},
    Mppx: {
      create: () => ({
        'stellar/charge': () => async () => ({
          status: 200,
          withReceipt: (r: Response) =>
            new Response(r.body, { headers: { 'payment-receipt': RECEIPT_HEADER } }),
        }),
      }),
    },
  },
})

const { routedockHono } = await import('../hono.js')
const { routedock } = await import('../routedockMiddleware.js')

const manifest: RouteDockManifest = {
  routedock: '1.0',
  name: 'Store Failure Test',
  description: 'Unit test provider',
  modes: ['x402', 'mpp-charge'],
  network: 'testnet',
  asset: 'USDC',
  asset_contract: ASSET_CONTRACT,
  payee: payeeKeypair.publicKey(),
  pricing: {
    x402: { amount: '0.001', per: 'request' },
    'mpp-charge': { amount: '0.0008', per: 'request' },
  },
  endpoints: { price: { method: 'GET', path: '/price' } },
  tags: ['test'],
}

const STORE_ERROR = new Error('supabase blip')

/** A store whose pre-settle get() succeeds and whose post-settle set() rejects. */
function failingStore(): SeenTxStore & { setCalls: number } {
  const store = {
    setCalls: 0,
    async get() {
      return null
    },
    async set() {
      store.setCalls++
      throw STORE_ERROR
    },
  }
  return store as unknown as SeenTxStore & { setCalls: number }
}

interface Spies {
  settled: Array<[string, string, string]>
  callbackErrors: Array<[unknown, string]>
}

function spies(): Spies {
  return { settled: [], callbackErrors: [] }
}

function adapterOptions(store: SeenTxStore, s: Spies) {
  return {
    modes: ['x402', 'mpp-charge'] as ('x402' | 'mpp-charge')[],
    pricing: { x402: '0.001', 'mpp-charge': '0.0008' },
    asset: 'USDC',
    assetContract: ASSET_CONTRACT,
    payee: payeeKeypair.publicKey(),
    network: 'testnet' as const,
    payeeSecretKey: payeeKeypair.secret(),
    commitmentPublicKey: commitKeypair.publicKey(),
    manifest,
    seenTxStore: store,
    logger: () => {},
    onSettled: async (txHash: string, amount: string, mode: string) => {
      s.settled.push([txHash, amount, mode])
    },
    onCallbackError: (err: unknown, cb: string) => {
      s.callbackErrors.push([err, cb])
    },
  }
}

/** onSettled runs on a later microtask. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 20))

const X402_HEADERS = { 'payment-signature': 'signed-payload' }
const MPP_HEADERS = { authorization: 'Payment credential="e30"' }

function assertStoreFailureReported(s: Spies) {
  assert.equal(s.callbackErrors.length, 1, 'onCallbackError called once')
  assert.equal(s.callbackErrors[0]![0], STORE_ERROR)
  assert.equal(s.callbackErrors[0]![1], 'seenTxStore.set')
}

describe('routedockHono — SeenTxStore.set rejects after settlement', () => {
  let store: ReturnType<typeof failingStore>
  let s: Spies
  let app: Hono

  beforeEach(() => {
    settleBehaviour = 'succeed'
    settleCalls = 0
    store = failingStore()
    s = spies()
    app = new Hono()
    app.use('*', routedockHono(adapterOptions(store, s)) as never)
    app.get('/price', (c) => c.json({ price: '42' }))
  })

  it('x402: serves the route with X-Payment-Response and still fires onSettled', async () => {
    const res = await app.request('/price', { headers: X402_HEADERS })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { price: '42' })
    assert.ok(res.headers.get('x-payment-response'))
    await tick()
    assert.equal(store.setCalls, 1)
    assert.deepEqual(s.settled, [['SETTLED_TX', '0.001', 'x402']])
    assertStoreFailureReported(s)
  })

  it('mpp-charge: serves the route with receipt headers and still fires onSettled', async () => {
    const res = await app.request('/price', { headers: MPP_HEADERS })
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { price: '42' })
    assert.equal(res.headers.get('payment-receipt'), RECEIPT_HEADER)
    await tick()
    assert.equal(store.setCalls, 1)
    assert.deepEqual(s.settled, [[RECEIPT_REFERENCE, '0.0008', 'mpp-charge']])
    assertStoreFailureReported(s)
  })

  it('a throwing onCallbackError does not turn the paid request into a 500', async () => {
    const throwing = adapterOptions(store, s)
    throwing.onCallbackError = () => {
      throw new Error('callback exploded')
    }
    const a = new Hono()
    a.use('*', routedockHono(throwing) as never)
    a.get('/price', (c) => c.json({ price: '42' }))
    const res = await a.request('/price', { headers: X402_HEADERS })
    assert.equal(res.status, 200)
  })

  it('x402: a rejected settle still returns 500 and never writes the store', async () => {
    settleBehaviour = 'reject'
    const res = await app.request('/price', { headers: X402_HEADERS })
    assert.equal(res.status, 500)
    assert.deepEqual(await res.json(), { error: 'Payment settlement failed' })
    await tick()
    assert.equal(settleCalls, 1)
    assert.equal(store.setCalls, 0, 'set() must not run when settlement failed')
    assert.equal(s.settled.length, 0)
    assert.equal(s.callbackErrors.length, 0)
  })
})

describe('routedock (Express) — SeenTxStore.set rejects after settlement', () => {
  let store: ReturnType<typeof failingStore>
  let s: Spies

  async function start(): Promise<{ url: string; close: () => Promise<void> }> {
    const app = express()
    app.use(routedock(adapterOptions(store, s) as Parameters<typeof routedock>[0]))
    app.get('/price', (_req: ExpressRequest, res: ExpressResponse) => {
      res.json({ price: '42' })
    })
    return new Promise((resolve) => {
      const server = createServer(app)
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        const port = typeof addr === 'object' && addr ? addr.port : 0
        resolve({
          url: `http://127.0.0.1:${port}`,
          close: () => new Promise<void>((res) => server.close(() => res())),
        })
      })
    })
  }

  beforeEach(() => {
    settleBehaviour = 'succeed'
    settleCalls = 0
    store = failingStore()
    s = spies()
  })

  it('x402: serves the route and still fires onSettled', async () => {
    const { url, close } = await start()
    try {
      const res = await fetch(`${url}/price`, { headers: X402_HEADERS })
      assert.equal(res.status, 200)
      assert.deepEqual(await res.json(), { price: '42' })
      await tick()
      assert.equal(store.setCalls, 1)
      assert.deepEqual(s.settled, [['SETTLED_TX', '0.001', 'x402']])
      assertStoreFailureReported(s)
    } finally {
      await close()
    }
  })

  it('mpp-charge: serves the route and still fires onSettled', async () => {
    const { url, close } = await start()
    try {
      const res = await fetch(`${url}/price`, { headers: MPP_HEADERS })
      assert.equal(res.status, 200)
      assert.deepEqual(await res.json(), { price: '42' })
      await tick()
      assert.equal(store.setCalls, 1)
      assert.deepEqual(s.settled, [[RECEIPT_REFERENCE, '0.0008', 'mpp-charge']])
      assertStoreFailureReported(s)
    } finally {
      await close()
    }
  })
})
