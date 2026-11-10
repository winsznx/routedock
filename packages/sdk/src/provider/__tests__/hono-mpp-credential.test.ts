import { mock, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import express from 'express'
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express'
import { Hono } from 'hono'
import { Keypair } from '@stellar/stellar-sdk'
import { Challenge, Credential } from 'mppx'
import type { RouteDockManifest } from '../../types.js'

const payeeKeypair = Keypair.random()
const commitKeypair = Keypair.random()
const payerKeypair = Keypair.random()

const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const CHANNEL_CONTRACT = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'
const CUMULATIVE_KEY = `stellar:channel:cumulative:${CHANNEL_CONTRACT}`
const RECEIPT_HEADER = Buffer.from(JSON.stringify({ reference: 'CHARGE_TX_REF' })).toString('base64')

type WrappedStore = { put: (key: string, value: unknown) => Promise<void> }
let capturedHonoStore: WrappedStore | null = null
let capturedExpressStore: WrappedStore | null = null
let closeCalls: Array<{ amount: bigint; signature: Uint8Array }> = []

mock.module('@stellar/mpp/channel/server', {
  namedExports: {
    Store: {
      memory: () => {
        const m = new Map<string, unknown>()
        return {
          async get(k: string) {
            return m.get(k)
          },
          async put(k: string, v: unknown) {
            m.set(k, v)
          },
          async delete(k: string) {
            m.delete(k)
          },
          update(k: string, fn: (v: unknown) => unknown) {
            m.set(k, fn(m.get(k)))
          },
        }
      },
    },
    close: async (opts: { amount: bigint; signature: Uint8Array }) => {
      closeCalls.push({ amount: opts.amount, signature: opts.signature })
      return 'MOCK_CLOSE_TX_HASH'
    },
    stellar: Object.assign(
      (opts: { store: unknown }) => {
        capturedHonoStore = opts.store as WrappedStore
        return []
      },
      {
        channel: (opts: { store: unknown }) => {
          capturedExpressStore = opts.store as WrappedStore
          return []
        },
      },
    ),
  },
})

mock.module('mppx/server', {
  namedExports: {
    Expires: {},
    Store: {},
    Request: {
      fromNodeListener: (req?: { headers?: Record<string, string | string[] | undefined> }) => {
        const headers = new Headers()
        if (req?.headers) {
          for (const [k, v] of Object.entries(req.headers)) {
            if (typeof v === 'string') headers.set(k, v)
          }
        }
        return new Request('http://localhost/price', { headers })
      },
    },
    Response: {},
    Transport: {},
    NodeListener: {},
    stripe: {},
    tempo: {},
    Mppx: {
      create: () => ({
        channel: (_opts: { amount: string }) => async (request: Request) => {
          const auth = request.headers.get('authorization')
          if (!auth?.startsWith('Payment ')) {
            return {
              status: 402,
              challenge: new Response('Payment Required', {
                status: 402,
                headers: {
                  'www-authenticate':
                    'Payment id="test", realm="test", method="stellar", intent="channel", request="e30"',
                },
              }),
            }
          }
          return { status: 200 }
        },
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
const { createMppSessionHandler } = await import('../MppSessionHandler.js')
const { createMppChargeHandler } = await import('../MppChargeHandler.js')

const sessionManifest: RouteDockManifest = {
  routedock: '1.0',
  name: 'Test Session Service',
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

const chargeManifest: RouteDockManifest = {
  routedock: '1.0',
  name: 'Test Charge Service',
  description: 'Unit test provider',
  modes: ['mpp-charge'],
  network: 'testnet',
  asset: 'USDC',
  asset_contract: ASSET_CONTRACT,
  payee: payeeKeypair.publicKey(),
  pricing: {
    'mpp-charge': { amount: '0.0008', per: 'request' },
  },
  endpoints: { price: { method: 'GET', path: '/price' } },
  tags: ['test'],
}

function buildSerializedVoucherHeader(amount: string, signature: string): string {
  const challenge = Challenge.from({
    id: 'c-voucher',
    realm: 'routedock',
    method: 'stellar',
    intent: 'channel',
    request: { amount: '1' },
  })
  return Credential.serialize(
    Credential.from({
      challenge,
      payload: { action: 'voucher', amount, signature },
    }),
  )
}

function buildSerializedChargeHeader(payerPublicKey: string): string {
  const challenge = Challenge.from({
    id: 'c-charge',
    realm: 'routedock',
    method: 'stellar',
    intent: 'charge',
    request: { amount: '8000' },
  })
  return Credential.serialize(
    Credential.from({
      challenge,
      payload: { type: 'transaction', transaction: 'AAAA...' },
      source: `did:pkh:stellar:testnet:${payerPublicKey}`,
    }),
  )
}

describe('Hono mpp-session — real mppx credential parsing (#390)', () => {
  it('records 128-char hex signature when store put matches header amount, and passes it to onVoucher and onOrphaned', async () => {
    const voucherCalls: Array<{ amount: string; signature: string }> = []
    let orphanInfo: { lastSignature: string; cumulativeAmount: string } | undefined

    const app = new Hono()
    app.use(
      '*',
      routedockHono({
        asset: 'USDC',
        assetContract: ASSET_CONTRACT,
        payee: payeeKeypair.publicKey(),
        network: 'testnet',
        payeeSecretKey: payeeKeypair.secret(),
        commitmentPublicKey: commitKeypair.publicKey(),
        manifest: sessionManifest,
        modes: ['mpp-session'],
        pricing: { 'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT } },
        idleTimeoutMs: 30,
        onVoucher: async (_id, _idx, amount, signature) => {
          voucherCalls.push({ amount, signature })
        },
        onOrphaned: async (_id, info) => {
          orphanInfo = info
        },
      }),
    )
    app.get('/price', (c) => c.json({ price: '42' }))

    assert.ok(capturedHonoStore, 'expected wrapped store to be captured')
    const sig128 = 'ab'.repeat(64)
    const authHeader = buildSerializedVoucherHeader('1000', sig128)

    const res = await app.request('/price', {
      method: 'GET',
      headers: { authorization: authHeader },
    })
    assert.equal(res.status, 200)

    await capturedHonoStore!.put(CUMULATIVE_KEY, { amount: '1000' })
    await new Promise((r) => setImmediate(r))

    assert.equal(voucherCalls.length, 1)
    assert.equal(voucherCalls[0]!.signature, sig128)

    // Keep event loop alive with a ref'd timer while the unref'd idleTimer fires
    await new Promise((r) => setTimeout(r, 120))
    assert.equal(orphanInfo?.lastSignature, sig128)
  })

  it('passes empty signature to onVoucher when store put amount differs from header payload.amount', async () => {
    const voucherCalls: Array<{ amount: string; signature: string }> = []

    const app = new Hono()
    app.use(
      '*',
      routedockHono({
        asset: 'USDC',
        assetContract: ASSET_CONTRACT,
        payee: payeeKeypair.publicKey(),
        network: 'testnet',
        payeeSecretKey: payeeKeypair.secret(),
        commitmentPublicKey: commitKeypair.publicKey(),
        manifest: sessionManifest,
        modes: ['mpp-session'],
        pricing: { 'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT } },
        onVoucher: async (_id, _idx, amount, signature) => {
          voucherCalls.push({ amount, signature })
        },
      }),
    )
    app.get('/price', (c) => c.json({ price: '42' }))

    assert.ok(capturedHonoStore, 'expected wrapped store to be captured')
    const sig128 = 'cd'.repeat(64)
    const authHeader = buildSerializedVoucherHeader('1000', sig128)

    const res = await app.request('/price', {
      method: 'GET',
      headers: { authorization: authHeader },
    })
    assert.equal(res.status, 200)

    // Store put amount ('2000') differs from header's payload.amount ('1000')
    await capturedHonoStore!.put(CUMULATIVE_KEY, { amount: '2000' })
    await new Promise((r) => setImmediate(r))

    assert.equal(voucherCalls.length, 1)
    assert.equal(voucherCalls[0]!.signature, '')
  })
})

describe('Express createMppSessionHandler — normal close with verified voucher (#390)', () => {
  it('calls close with amount N and voucher signature bytes on DELETE { amount: N, signature }', async () => {
    closeCalls = []
    const app = express()
    app.use(express.json())
    app.use(
      createMppSessionHandler({
        payeeSecretKey: payeeKeypair.secret(),
        network: 'testnet',
        channelFactory: CHANNEL_CONTRACT,
        rate: '0.0001',
        assetContract: ASSET_CONTRACT,
        manifest: sessionManifest,
        commitmentPublicKey: commitKeypair.publicKey(),
      }),
    )
    app.get('/price', (_req: ExpressRequest, res: ExpressResponse) => {
      res.json({ price: '42' })
    })

    assert.ok(capturedExpressStore, 'expected Express wrapped store to be captured')

    const server = createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    const url = `http://127.0.0.1:${port}`

    try {
      const sig128 = 'ef'.repeat(64)
      const authHeader = buildSerializedVoucherHeader('1000', sig128)

      const getRes = await fetch(`${url}/price`, {
        headers: { authorization: authHeader },
      })
      assert.equal(getRes.status, 200)

      await capturedExpressStore!.put(CUMULATIVE_KEY, { amount: '1000' })

      const delRes = await fetch(`${url}/price`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amount: '1000', signature: sig128 }),
      })
      assert.equal(delRes.status, 200)
      const body = (await delRes.json()) as { closeTxHash: string | null }
      assert.ok(body.closeTxHash, 'expected non-null closeTxHash')
      assert.equal(closeCalls.length, 1)
      assert.equal(closeCalls[0]!.amount, 1000n)
      assert.deepEqual([...closeCalls[0]!.signature], [...Buffer.from(sig128, 'hex')])
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})

describe('Hono and Express mpp-charge — DID payer attribution (#390)', () => {
  it('Hono mpp-charge reports payer from did:pkh:stellar:testnet:<G> to onSettled', async () => {
    const settled: Array<{ txHash: string; amount: string; mode: string; payer: string | null }> = []
    const app = new Hono()
    app.use(
      '*',
      routedockHono({
        asset: 'USDC',
        assetContract: ASSET_CONTRACT,
        payee: payeeKeypair.publicKey(),
        network: 'testnet',
        payeeSecretKey: payeeKeypair.secret(),
        manifest: chargeManifest,
        modes: ['mpp-charge'],
        pricing: { 'mpp-charge': '0.0008' },
        onSettled: async (txHash, amount, mode, payer) => {
          settled.push({ txHash, amount, mode, payer })
        },
      }),
    )
    app.get('/price', (c) => c.json({ price: '42' }))

    const payerG = payerKeypair.publicKey()
    const authHeader = buildSerializedChargeHeader(payerG)
    const res = await app.request('/price', {
      method: 'GET',
      headers: { authorization: authHeader },
    })
    assert.equal(res.status, 200)
    await new Promise((r) => setImmediate(r))

    assert.equal(settled.length, 1)
    assert.equal(settled[0]!.mode, 'mpp-charge')
    assert.equal(settled[0]!.payer, payerG)
  })

  it('Express mpp-charge reports payer from did:pkh:stellar:testnet:<G> to onSettled', async () => {
    const settled: Array<{ txHash: string; amount: string; mode: string; payer: string | null }> = []
    const app = express()
    app.use(
      createMppChargeHandler({
        payeeSecretKey: payeeKeypair.secret(),
        network: 'testnet',
        amount: '0.0008',
        assetContract: ASSET_CONTRACT,
        manifest: chargeManifest,
        onSettled: async (txHash, amount, mode, payer) => {
          settled.push({ txHash, amount, mode, payer })
        },
      }),
    )
    app.get('/price', (_req: ExpressRequest, res: ExpressResponse) => {
      res.json({ price: '42' })
    })

    const server = createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    const url = `http://127.0.0.1:${port}`

    try {
      const payerG = payerKeypair.publicKey()
      const authHeader = buildSerializedChargeHeader(payerG)
      const res = await fetch(`${url}/price`, {
        headers: { authorization: authHeader },
      })
      assert.equal(res.status, 200)
      await new Promise((r) => setImmediate(r))

      assert.equal(settled.length, 1)
      assert.equal(settled[0]!.mode, 'mpp-charge')
      assert.equal(settled[0]!.payer, payerG)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
