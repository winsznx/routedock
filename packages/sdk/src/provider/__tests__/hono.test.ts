import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Hono } from 'hono'
import { Keypair } from '@stellar/stellar-sdk'
import { routedockHono } from '../hono.js'
import type { RouteDockManifest } from '../../types.js'

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
  modes: ('x402' | 'mpp-charge' | 'mpp-session')[]
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
