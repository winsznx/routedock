import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Hono } from 'hono'
import { Keypair } from '@stellar/stellar-sdk'
import { routedockHono } from '../hono.js'
import type { RouteDockManifest } from '../../types.js'
import { ExactStellarScheme as ExactStellarFacilitatorScheme } from '@x402/stellar/exact/facilitator'
import { x402ResourceServer } from '@x402/core/server'
import { encodePaymentSignatureHeader } from '@x402/core/http'

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

function makeApp(overrides: Partial<typeof BASE_OPTS & {
  modes: ('x402' | 'mpp-charge' | 'mpp-session' | 'mpp-session-ws')[]
  pricing: Record<string, unknown>
}> = {}) {
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
    } as Parameters<typeof routedockHono>[0]),
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

  it('returns { closeTxHash: null } on DELETE with no prior vouchers', async () => {
    const app = makeApp({
      modes: ['mpp-session'],
      pricing: {
        'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT },
      },
    })
    const res = await app.request('/price', { method: 'DELETE' })
    assert.equal(res.status, 200)
    const body = await res.json() as { closeTxHash: null }
    assert.equal(body.closeTxHash, null)
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

  it('returns { closeTxHash: null } on DELETE with no prior vouchers', async () => {
    const app = makeApp({
      modes: ['mpp-session-ws'],
      pricing: {
        'mpp-session-ws': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT },
      },
    })
    const res = await app.request('/price', { method: 'DELETE' })
    assert.equal(res.status, 200)
    const body = await res.json() as { closeTxHash: null }
    assert.equal(body.closeTxHash, null)
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

// ── #392 — a failed settle must not serve paid content ────────────────────────
//
// @x402/stellar's settle() returns { success:false, transaction, errorReason }
// instead of throwing when submission or on-chain execution fails. The handler
// used to treat any truthy result as settled, serving the resource for free and
// writing a poisoned idempotency record. These stub settle to fail.

// A payment header the handler's decodePaymentSignatureHeader will round-trip.
const FAKE_PAYMENT_HEADER = encodePaymentSignatureHeader({
  x402Version: 2,
  scheme: 'exact',
  network: 'stellar:testnet',
  payload: { authorization: { credentials: [] } },
} as unknown as Parameters<typeof encodePaymentSignatureHeader>[0])

function makeSpyStore() {
  const setCalls: Array<[string, unknown]> = []
  const store = {
    get: async () => undefined,
    set: async (k: string, v: unknown) => {
      setCalls.push([k, v])
    },
  }
  return { store, setCalls }
}

describe('routedockHono — #392 settle failure guard (local facilitator)', () => {
  function makeApp(settleResult: unknown) {
    const { store, setCalls } = makeSpyStore()
    let onSettledCalls = 0
    const app = new Hono()
    app.use(
      '*',
      routedockHono({
        ...BASE_OPTS,
        modes: ['x402'],
        pricing: { x402: '0.001' },
        seenTxStore: store,
        onSettled: async () => {
          onSettledCalls++
        },
      } as unknown as Parameters<typeof routedockHono>[0]),
    )
    app.get('/price', (c) => c.json({ price: '42' }))

    const origVerify = ExactStellarFacilitatorScheme.prototype.verify
    const origSettle = ExactStellarFacilitatorScheme.prototype.settle
    ;(ExactStellarFacilitatorScheme.prototype as { verify: unknown }).verify = async () => ({
      isValid: true,
    })
    ;(ExactStellarFacilitatorScheme.prototype as { settle: unknown }).settle = async () => settleResult
    const restore = () => {
      ExactStellarFacilitatorScheme.prototype.verify = origVerify
      ExactStellarFacilitatorScheme.prototype.settle = origSettle
    }
    return { app, setCalls, getOnSettledCalls: () => onSettledCalls, restore }
  }

  it('returns 402 and does not serve the resource when settle reports success:false', async () => {
    const { app, setCalls, getOnSettledCalls, restore } = makeApp({
      success: false,
      transaction: '',
      errorReason: 'settle_exact_stellar_transaction_submission_failed',
    })
    try {
      const res = await app.request('/price', { headers: { 'x-payment': FAKE_PAYMENT_HEADER } })
      assert.equal(res.status, 402)
      assert.equal(res.headers.get('x-payment-response'), null, 'no X-Payment-Response on failure')
      const body = (await res.json()) as { error: string; price?: string }
      assert.equal(body.error, 'Payment settlement failed')
      assert.equal(body.price, undefined, 'the protected /price handler must not run')
      await new Promise((r) => setTimeout(r, 0))
      assert.equal(setCalls.length, 0, 'no idempotency record on a failed settle')
      assert.equal(getOnSettledCalls(), 0, 'onSettled is not called on a failed settle')
    } finally {
      restore()
    }
  })

  it('rejects a settle result with success:true but an empty transaction', async () => {
    const { app, setCalls, restore } = makeApp({ success: true, transaction: '' })
    try {
      const res = await app.request('/price', { headers: { 'x-payment': FAKE_PAYMENT_HEADER } })
      assert.equal(res.status, 402)
      assert.equal(res.headers.get('x-payment-response'), null)
      await new Promise((r) => setTimeout(r, 0))
      assert.equal(setCalls.length, 0)
    } finally {
      restore()
    }
  })
})

describe('routedockHono — #392 settle failure guard (OZ facilitator)', () => {
  it('returns 402 when ozServer.settlePayment reports success:false', async () => {
    const { store, setCalls } = makeSpyStore()
    const app = new Hono()
    app.use(
      '*',
      routedockHono({
        ...BASE_OPTS,
        network: 'mainnet',
        facilitatorApiKey: 'test-key',
        modes: ['x402'],
        pricing: { x402: '0.001' },
        seenTxStore: store,
      } as unknown as Parameters<typeof routedockHono>[0]),
    )
    app.get('/price', (c) => c.json({ price: '42' }))

    const proto = x402ResourceServer.prototype as {
      settlePayment: unknown
      createPaymentRequiredResponse: unknown
    }
    const origSettle = proto.settlePayment
    const origReq = proto.createPaymentRequiredResponse
    proto.settlePayment = async () => ({ success: false, transaction: '', errorReason: 'oz_fail' })
    proto.createPaymentRequiredResponse = async () => ({
      x402Version: 2,
      resource: { url: 'https://provider.test/price', description: 'x' },
      accepts: [
        {
          scheme: 'exact',
          network: 'stellar:pubnet',
          asset: ASSET_CONTRACT,
          amount: '1000',
          payTo: payeeKeypair.publicKey(),
          maxTimeoutSeconds: 60,
          extra: { areFeesSponsored: true },
        },
      ],
    })
    try {
      const res = await app.request('/price', { headers: { 'x-payment': FAKE_PAYMENT_HEADER } })
      assert.equal(res.status, 402)
      assert.equal(res.headers.get('x-payment-response'), null)
      const body = (await res.json()) as { error: string; price?: string }
      assert.equal(body.error, 'Payment settlement failed')
      assert.equal(body.price, undefined)
      await new Promise((r) => setTimeout(r, 0))
      assert.equal(setCalls.length, 0)
    } finally {
      proto.settlePayment = origSettle
      proto.createPaymentRequiredResponse = origReq
    }
  })
})
