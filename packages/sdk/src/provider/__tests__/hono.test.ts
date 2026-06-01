/**
 * Unit tests for the Hono provider adapter (@routedock/routedock/provider/hono).
 *
 * Exercises x402, mpp-charge, and mpp-session flows through Hono's app.request()
 * harness. Only the payment-challenge / routing / lifecycle surface is tested —
 * no testnet RPC is performed (settlement requires a real signed credential and
 * is covered by the live agent run, not these unit tests).
 *
 * Run with: pnpm --filter @routedock/routedock test
 */

import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { Keypair } from '@stellar/stellar-sdk'
import { routedockHono } from '../hono.js'
import type { RouteDockManifest, PaymentMode } from '../../types.js'

const payee = Keypair.random()
const commitment = Keypair.random()

const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const CHANNEL_CONTRACT = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'

function buildManifest(modes: PaymentMode[]): RouteDockManifest {
  return {
    routedock: '1.0',
    name: 'Hono Test Provider',
    description: 'Provider exercised by the Hono adapter unit tests',
    modes,
    network: 'testnet',
    asset: 'USDC',
    asset_contract: ASSET_CONTRACT,
    payee: payee.publicKey(),
    pricing: {
      x402: { amount: '0.001', per: 'request' },
      'mpp-charge': { amount: '0.0008', per: 'request' },
      'mpp-session': {
        rate: '0.0001',
        per: 'voucher',
        channel_contract: CHANNEL_CONTRACT,
        min_deposit: '0.10',
        refund_waiting_period_ledgers: 17280,
      },
    },
    endpoints: { price: 'GET /price' },
    tags: ['price', 'stellar', 'test'],
  }
}

function buildApp(modes: PaymentMode[]): Hono {
  const app = new Hono()
  app.use(
    '*',
    routedockHono({
      modes,
      pricing: {
        x402: '0.001',
        'mpp-charge': '0.0008',
        'mpp-session': { rate: '0.0001', channelContract: CHANNEL_CONTRACT },
      },
      asset: 'USDC',
      assetContract: ASSET_CONTRACT,
      payee: payee.publicKey(),
      network: 'testnet',
      payeeSecretKey: payee.secret(),
      commitmentPublicKey: commitment.publicKey(),
      manifest: buildManifest(modes),
    }),
  )
  app.get('/price', (c) => c.json({ price: '1.2345' }))
  return app
}

// ── Test 1: manifest served at /.well-known/routedock.json ────────────────────

{
  // #given a provider mounted with any mode
  const app = buildApp(['x402'])

  // #when the discovery manifest is requested
  const res = await app.request('/.well-known/routedock.json')

  // #then the full manifest is returned as JSON
  assert.equal(res.status, 200, 'manifest request should return 200')
  const body = (await res.json()) as RouteDockManifest
  assert.equal(body.routedock, '1.0', 'manifest version should be 1.0')
  assert.equal(body.payee, payee.publicKey(), 'manifest payee should match')

  console.log('✓ Test 1: manifest serving PASSED')
}

// ── Test 2: x402 — unpaid request returns 402 challenge ───────────────────────

{
  // #given an x402-only provider
  const app = buildApp(['x402'])

  // #when a protected route is hit without a payment header
  const res = await app.request('/price')

  // #then a 402 challenge with x402 payment requirements is returned
  assert.equal(res.status, 402, 'x402 unpaid request should return 402')
  assert.ok(
    res.headers.get('x-payment-requirements'),
    'x402 challenge should set X-Payment-Requirements header',
  )
  const body = (await res.json()) as { error: string }
  assert.equal(body.error, 'Payment Required', 'x402 challenge body should say Payment Required')

  console.log('✓ Test 2: x402 unpaid challenge PASSED')
}

// ── Test 3: mpp-charge — unpaid request returns 402 challenge ──────────────────

{
  // #given an mpp-charge-only provider
  const app = buildApp(['mpp-charge'])

  // #when a protected route is hit without a credential
  const res = await app.request('/price')

  // #then a 402 challenge is returned (mppx charge scheme, not x402)
  assert.equal(res.status, 402, 'mpp-charge unpaid request should return 402')
  assert.equal(
    res.headers.get('x-payment-requirements'),
    null,
    'mpp-charge challenge should NOT use the x402 X-Payment-Requirements header',
  )

  console.log('✓ Test 3: mpp-charge unpaid challenge PASSED')
}

// ── Test 4: mode routing — header selects x402 vs the fallback handler ─────────

{
  // #given a provider supporting both x402 and mpp-charge
  const app = buildApp(['x402', 'mpp-charge'])

  // #when the client explicitly prefers x402
  const preferred = await app.request('/price', {
    headers: { 'x-preferred-mode': 'x402' },
  })

  // #then it is routed to the x402 handler (X-Payment-Requirements present)
  assert.equal(preferred.status, 402, 'preferred x402 should return 402')
  assert.ok(
    preferred.headers.get('x-payment-requirements'),
    'x-preferred-mode=x402 should route to the x402 handler',
  )

  // #when no preference is given
  const fallback = await app.request('/price')

  // #then it falls through to the last handler (mpp-charge), not x402
  assert.equal(fallback.status, 402, 'fallback should return 402')
  assert.equal(
    fallback.headers.get('x-payment-requirements'),
    null,
    'no preference should route to the mpp-charge fallback, not x402',
  )

  console.log('✓ Test 4: header-based mode routing PASSED')
}

// ── Test 5: mpp-session — unpaid voucher challenge + DELETE close lifecycle ────

{
  // #given an mpp-session-only provider
  const app = buildApp(['mpp-session'])

  // #when a protected route is hit without a voucher
  const challenge = await app.request('/price')

  // #then a 402 challenge is returned
  assert.equal(challenge.status, 402, 'mpp-session unpaid request should return 402')

  // #when the channel is closed with no vouchers received
  const close = await app.request('/price', { method: 'DELETE' })

  // #then no on-chain close occurs and the adapter reports it cleanly
  assert.equal(close.status, 200, 'DELETE close should return 200')
  const body = (await close.json()) as { closeTxHash: string | null; message?: string }
  assert.equal(body.closeTxHash, null, 'close with no vouchers should have null txHash')
  assert.equal(body.message, 'no vouchers received', 'close should report no vouchers received')

  console.log('✓ Test 5: mpp-session challenge + close lifecycle PASSED')
}

// ── Test 6: mpp-session requires a commitment public key ──────────────────────

{
  // #given an mpp-session config missing commitmentPublicKey
  // #when the adapter is constructed
  // #then it throws a descriptive configuration error
  assert.throws(
    () => {
      const app = new Hono()
      app.use(
        '*',
        routedockHono({
          modes: ['mpp-session'],
          pricing: { 'mpp-session': { rate: '0.0001', channelContract: CHANNEL_CONTRACT } },
          asset: 'USDC',
          assetContract: ASSET_CONTRACT,
          payee: payee.publicKey(),
          network: 'testnet',
          payeeSecretKey: payee.secret(),
          manifest: buildManifest(['mpp-session']),
        }),
      )
    },
    /mpp-session mode requires commitmentPublicKey/,
    'missing commitmentPublicKey should throw',
  )

  console.log('✓ Test 6: mpp-session commitment key guard PASSED')
}

console.log('\nAll Hono adapter tests passed.')
