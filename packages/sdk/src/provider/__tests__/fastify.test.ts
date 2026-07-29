import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import Fastify from 'fastify'
import { Keypair } from '@stellar/stellar-sdk'
import { routedockFastify } from '../fastify.js'
import type { RouteDockManifest } from '../../types.js'

// Generate fresh keypairs — avoids hardcoding secrets while keeping tests self-contained
const payeeKeypair = Keypair.random()
const commitKeypair = Keypair.random()

const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const CHANNEL_CONTRACT = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'

const manifest: RouteDockManifest = {
  routedock: '1.0',
  name: 'Test Fastify Service',
  description: 'Unit test fastify provider',
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

async function makeApp(overrides: Partial<typeof BASE_OPTS & {
  modes: ('x402' | 'mpp-charge' | 'mpp-session')[]
  pricing: Record<string, unknown>
}> = {}) {
  const app = Fastify()

  // Call the plugin directly on the root instance rather than via app.register().
  // app.register() creates an encapsulated child scope, so the onRequest hook
  // would only fire for routes inside that child scope. Calling directly adds
  // the hook to the root scope, where our test routes live.
  const plugin = routedockFastify({
    ...BASE_OPTS,
    modes: ['x402', 'mpp-charge', 'mpp-session'],
    pricing: {
      x402: '0.001',
      'mpp-charge': '0.0008',
      'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT },
    },
    ...overrides,
  } as Parameters<typeof routedockFastify>[0])

  await plugin(app as any, {})

  app.get('/price', async () => ({ price: '42' }))
  await app.ready()
  return app
}

// ---------------------------------------------------------------------------
// Manifest endpoint
// ---------------------------------------------------------------------------

describe('routedockFastify — manifest endpoint', () => {
  it('serves /.well-known/routedock.json', async () => {
    const app = await makeApp({ modes: [] as ('x402' | 'mpp-charge' | 'mpp-session')[], pricing: {} })
    const res = await app.inject({ method: 'GET', url: '/.well-known/routedock.json' })
    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.body) as { name: string }
    assert.equal(body.name, manifest.name)
    await app.close()
  })

  it('passes through when no modes are configured', async () => {
    const app = await makeApp({ modes: [], pricing: {} })
    const res = await app.inject({ method: 'GET', url: '/price' })
    assert.equal(res.statusCode, 200)
    await app.close()
  })
})

// ---------------------------------------------------------------------------
// x402 flow
// ---------------------------------------------------------------------------

describe('routedockFastify — x402 flow', () => {
  it('returns 402 with X-Payment-Requirements when no payment header', async () => {
    const app = await makeApp({ modes: ['x402'], pricing: { x402: '0.001' } })
    const res = await app.inject({ method: 'GET', url: '/price' })
    assert.equal(res.statusCode, 402)
    assert.ok(
      res.headers['x-payment-requirements'],
      'expected X-Payment-Requirements header',
    )
    const body = JSON.parse(res.body) as { error: string }
    assert.equal(body.error, 'Payment Required')
    await app.close()
  })

  it('routes to x402 handler when x-preferred-mode: x402 header is set', async () => {
    const app = await makeApp({
      modes: ['x402', 'mpp-charge'],
      pricing: { x402: '0.001', 'mpp-charge': '0.0008' },
    })
    const res = await app.inject({
      method: 'GET',
      url: '/price',
      headers: { 'x-preferred-mode': 'x402' },
    })
    assert.equal(res.statusCode, 402)
    assert.ok(res.headers['x-payment-requirements'])
    await app.close()
  })
})

// ---------------------------------------------------------------------------
// mpp-charge flow
// ---------------------------------------------------------------------------

describe('routedockFastify — mpp-charge flow', () => {
  it('returns 402 challenge when no authorization header', async () => {
    const app = await makeApp({ modes: ['mpp-charge'], pricing: { 'mpp-charge': '0.0008' } })
    const res = await app.inject({ method: 'GET', url: '/price' })
    assert.equal(res.statusCode, 402)
    await app.close()
  })
})

// ---------------------------------------------------------------------------
// mpp-session flow
// ---------------------------------------------------------------------------

describe('routedockFastify — mpp-session flow', () => {
  it('returns 402 challenge when no authorization header', async () => {
    const app = await makeApp({
      modes: ['mpp-session'],
      pricing: { 'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT } },
    })
    const res = await app.inject({ method: 'GET', url: '/price' })
    assert.equal(res.statusCode, 402)
    await app.close()
  })

  it('returns { closeTxHash: null } on DELETE with no prior vouchers', async () => {
    const app = await makeApp({
      modes: ['mpp-session'],
      pricing: { 'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT } },
    })
    const res = await app.inject({ method: 'DELETE', url: '/price' })
    assert.equal(res.statusCode, 200)
    const body = JSON.parse(res.body) as { closeTxHash: null }
    assert.equal(body.closeTxHash, null)
    await app.close()
  })
})

// ---------------------------------------------------------------------------
// Constructor validation
// ---------------------------------------------------------------------------

describe('routedockFastify — constructor validation', () => {
  it('throws when mpp-session mode is enabled without commitmentPublicKey', () => {
    const { commitmentPublicKey: _ignored, ...withoutCommitment } = BASE_OPTS
    assert.throws(
      () =>
        routedockFastify({
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
