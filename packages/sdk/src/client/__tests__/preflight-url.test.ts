/**
 * Tests for RouteDockClient.preflight(url)
 *
 * Verifies that preflight(url):
 *   1. Fetches + validates the manifest and returns modes, per-mode costs, compliance flags
 *   2. Moves no money and makes no trustline (Horizon) call
 *   3. Reports session pricing per voucher with min_deposit
 *   4. Surfaces deprecation / sunset flags
 *   5. Throws RouteDockManifestError for unreachable or invalid manifests
 *   6. Throws RouteDockManifestSunsetError for a sunset endpoint
 *
 * Run with: pnpm --filter @routedock/routedock test
 */

import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import assert from 'node:assert/strict'
import { Keypair } from '@stellar/stellar-sdk'
import { RouteDockClient } from '../RouteDockClient.js'
import { RouteDockManifestError, RouteDockManifestSunsetError } from '../../errors.js'
import { signManifest } from '../../manifest/sign.js'

// ── Helper ─────────────────────────────────────────────────────────────────────

function startTestServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((res) => server.close(() => res())),
      })
    })
  })
}

function serveManifest(manifest: unknown) {
  return startTestServer((req, res) => {
    if (req.url === '/.well-known/routedock.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
    } else {
      res.writeHead(404); res.end()
    }
  })
}

/** Client whose payment clients and trustline check fail the test if touched. */
function makeClient(): RouteDockClient {
  const client = new RouteDockClient({ wallet: Keypair.random(), network: 'testnet' })
  const fail = (what: string) => async () => { assert.fail(`${what} must NOT be called by preflight(url)`) }
  const internals = client as unknown as {
    x402: { pay: unknown }
    charge: { pay: unknown }
    session: { openSession: unknown }
    _checkTrustline: unknown
  }
  internals.x402.pay = fail('x402.pay')
  internals.charge.pay = fail('charge.pay')
  internals.session.openSession = fail('session.openSession')
  internals._checkTrustline = fail('_checkTrustline')
  return client
}

const PAYEE_KEYPAIR = Keypair.random()

const BASE_MANIFEST = signManifest({
  routedock: '1.0',
  name: 'Preflight Test Provider',
  description: 'Provider exercised by preflight(url) tests',
  modes: ['x402', 'mpp-charge'],
  network: 'testnet',
  asset: 'USDC',
  asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
  payee: PAYEE_KEYPAIR.publicKey(),
  pricing: {
    x402: { amount: '0.001', per: 'request', facilitator: 'https://channels.openzeppelin.com/x402/testnet' },
    'mpp-charge': { amount: '0.0008', per: 'request' },
  },
  endpoints: { price: { method: 'GET', path: '/price' } },
  tags: ['price', 'stellar'],
}, PAYEE_KEYPAIR.secret())

// ── Test 1: returns modes, costs, compliance flags; no money movement ─────────

{
  const server = await serveManifest(BASE_MANIFEST)
  try {
    const result = await makeClient().preflight(`${server.url}/price`)

    assert.deepEqual(result.modes, ['x402', 'mpp-charge'])
    assert.deepEqual(result.costs, [
      { mode: 'x402', amount: '0.001', per: 'request', asset: 'USDC' },
      { mode: 'mpp-charge', amount: '0.0008', per: 'request', asset: 'USDC' },
    ])
    assert.deepEqual(result.compliance, { deprecated_modes: [], endpoint_deprecated: false })

    console.log('✓ Test 1: preflight(url) returns modes, costs and compliance flags with no payment')
  } finally {
    await server.close()
  }
}

// ── Test 2: session modes are priced per voucher with min_deposit ─────────────

{
  const sessionPricing = {
    rate: '0.0001',
    per: 'voucher' as const,
    channel_factory: 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH',
    min_deposit: '0.10',
    refund_waiting_period_ledgers: 17280,
  }
  const manifest = signManifest({
    ...BASE_MANIFEST,
    modes: ['x402', 'mpp-session'],
    pricing: { x402: BASE_MANIFEST.pricing.x402!, 'mpp-session': sessionPricing },
  }, PAYEE_KEYPAIR.secret())

  const server = await serveManifest(manifest)
  try {
    const result = await makeClient().preflight(`${server.url}/price`)

    assert.deepEqual(result.costs[1], {
      mode: 'mpp-session',
      amount: '0.0001',
      per: 'voucher',
      asset: 'USDC',
      min_deposit: '0.10',
    })

    console.log('✓ Test 2: session mode reports per-voucher rate and min_deposit')
  } finally {
    await server.close()
  }
}

// ── Test 3: deprecation / sunset flags ────────────────────────────────────────

{
  const manifestSunset = new Date(Date.now() + 30 * 86_400_000).toISOString()
  const endpointSunset = new Date(Date.now() + 10 * 86_400_000).toISOString()
  const manifest = signManifest({
    ...BASE_MANIFEST,
    deprecated_modes: ['x402'],
    sunset_at: manifestSunset,
    endpoints: { price: { method: 'GET', path: '/price', deprecated: true, sunset_at: endpointSunset } },
  }, PAYEE_KEYPAIR.secret())

  const server = await serveManifest(manifest)
  try {
    const result = await makeClient().preflight(`${server.url}/price`)

    assert.deepEqual(result.compliance, {
      deprecated_modes: ['x402'],
      sunset_at: manifestSunset,
      endpoint_deprecated: true,
      endpoint_sunset_at: endpointSunset,
    })

    console.log('✓ Test 3: preflight(url) surfaces deprecated modes, manifest and endpoint sunset')
  } finally {
    await server.close()
  }
}

// ── Test 4: unreachable and invalid manifests throw RouteDockManifestError ────

{
  const missing = await startTestServer((_req, res) => { res.writeHead(404); res.end() })
  try {
    await assert.rejects(
      () => makeClient().preflight(`${missing.url}/price`),
      (err: unknown) => err instanceof RouteDockManifestError,
    )
  } finally {
    await missing.close()
  }

  const garbage = await serveManifest('not json')
  try {
    await assert.rejects(
      () => makeClient().preflight(`${garbage.url}/price`),
      (err: unknown) => err instanceof RouteDockManifestError,
    )
  } finally {
    await garbage.close()
  }

  const invalid = await serveManifest({ ...BASE_MANIFEST, modes: 'x402' })
  try {
    await assert.rejects(
      () => makeClient().preflight(`${invalid.url}/price`),
      (err: unknown) => err instanceof RouteDockManifestError,
    )
  } finally {
    await invalid.close()
  }

  console.log('✓ Test 4: unreachable / non-JSON / schema-invalid manifests throw RouteDockManifestError')
}

// ── Test 5: sunset endpoint is rejected ───────────────────────────────────────

{
  const manifest = signManifest({
    ...BASE_MANIFEST,
    endpoints: { price: { method: 'GET', path: '/price', sunset_at: new Date(Date.now() - 86_400_000).toISOString() } },
  }, PAYEE_KEYPAIR.secret())

  const server = await serveManifest(manifest)
  try {
    await assert.rejects(
      () => makeClient().preflight(`${server.url}/price`),
      (err: unknown) => err instanceof RouteDockManifestSunsetError,
    )

    console.log('✓ Test 5: preflight(url) rejects a sunset endpoint')
  } finally {
    await server.close()
  }
}

console.log('\nAll preflight(url) tests passed.')
