/**
 * Tests for per-endpoint deprecation and sunset enforcement.
 *
 * Verifies that RouteDockClient.pay(), estimateCost() and openSession() refuse
 * a URL whose matching endpoint descriptor has a past sunset_at, warn before
 * paying a deprecated endpoint, ignore query strings, leave unlisted paths
 * alone, and re-check a cached manifest against the current clock.
 *
 * Run with: pnpm --filter @routedock/routedock test
 */

import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import assert from 'node:assert/strict'
import { Keypair } from '@stellar/stellar-sdk'
import { RouteDockClient } from '../RouteDockClient.js'
import { RouteDockManifestSunsetError } from '../../errors.js'
import type { EndpointDescriptor, PaymentResult, RouteDockManifest } from '../../types.js'
import { signManifest } from '../../manifest/sign.js'

function startTestServer(
  body: unknown,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((res) => server.close(() => res())),
      })
    })
  })
}

const PAYEE_KEYPAIR = Keypair.random()

function endpointManifest(
  endpoints: Record<string, EndpointDescriptor>,
  overrides: Partial<RouteDockManifest> = {},
): RouteDockManifest & { signature: string } {
  return signManifest(
    {
      routedock: '1.0',
      name: 'Endpoint Sunset Test Provider',
      description: 'Provider exercised by endpoint sunset tests',
      modes: ['x402', 'mpp-charge'],
      network: 'testnet',
      asset: 'USDC',
      asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      payee: PAYEE_KEYPAIR.publicKey(),
      pricing: {
        x402: {
          amount: '0.001',
          per: 'request',
          facilitator: 'https://channels.openzeppelin.com/x402/testnet',
        },
        'mpp-charge': { amount: '0.0008', per: 'request' },
      },
      endpoints,
      tags: ['price', 'stellar'],
      ...overrides,
    },
    PAYEE_KEYPAIR.secret(),
  )
}

/** Stub the trustline preflight and both sub-client pay() methods (offline). */
function stubSubClients(client: RouteDockClient): { x402Called: boolean; chargeCalled: boolean } {
  const calls = { x402Called: false, chargeCalled: false }
  const fakeResult: PaymentResult = {
    data: { ok: true },
    txHash: 'deadbeef',
    mode: 'mpp-charge',
    amount: '0.0008',
    timestamp: Date.now(),
  }
  ;(client as any)._checkTrustline = async () => {}
  ;(client as any).x402.pay = async () => {
    calls.x402Called = true
    return fakeResult
  }
  ;(client as any).charge.pay = async () => {
    calls.chargeCalled = true
    return fakeResult
  }
  return calls
}

// ── Test 1: pay() rejects a sunset endpoint without touching sub-clients ──────

{
  const past = new Date(Date.now() - 60_000).toISOString()
  const server = await startTestServer(
    endpointManifest({ price: { method: 'GET', path: '/price', sunset_at: past } }),
  )

  try {
    const client = new RouteDockClient({ wallet: Keypair.random(), network: 'testnet' })
    const calls = stubSubClients(client)

    await assert.rejects(
      () => client.pay(`${server.url}/price`),
      (error: unknown) => {
        assert.ok(error instanceof RouteDockManifestSunsetError)
        assert.equal(error.code, 'MANIFEST_SUNSET')
        assert.equal(error.retryable, false)
        return true
      },
    )
    assert.equal(calls.x402Called, false, 'x402.pay must not be called for a sunset endpoint')
    assert.equal(calls.chargeCalled, false, 'charge.pay must not be called for a sunset endpoint')

    console.log('✓ Test 1: pay() rejects a sunset endpoint without touching sub-clients')
  } finally {
    await server.close()
  }
}

// ── Test 2: estimateCost() rejects a sunset endpoint ──────────────────────────

{
  const past = new Date(Date.now() - 60_000).toISOString()
  const server = await startTestServer(
    endpointManifest({ price: { method: 'GET', path: '/price', sunset_at: past } }),
  )

  try {
    const client = new RouteDockClient({ wallet: Keypair.random(), network: 'testnet' })

    await assert.rejects(
      () => client.estimateCost(`${server.url}/price`),
      (error: unknown) => error instanceof RouteDockManifestSunsetError,
    )

    console.log('✓ Test 2: estimateCost() rejects a sunset endpoint')
  } finally {
    await server.close()
  }
}

// ── Test 3: openSession() rejects before the commitmentSecret check ───────────

{
  const past = new Date(Date.now() - 60_000).toISOString()
  const server = await startTestServer(
    endpointManifest(
      { stream: { method: 'POST', path: '/stream', sunset_at: past } },
      {
        modes: ['mpp-session'],
        pricing: {
          'mpp-session': {
            rate: '0.0001',
            per: 'voucher',
            channel_factory: 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH',
            min_deposit: '0.10',
            refund_waiting_period_ledgers: 17280,
          },
        },
      },
    ),
  )

  try {
    // No commitmentSecret on purpose: the endpoint check must run first.
    const client = new RouteDockClient({ wallet: Keypair.random(), network: 'testnet' })

    await assert.rejects(
      () => client.openSession(`${server.url}/stream`),
      (error: unknown) => error instanceof RouteDockManifestSunsetError,
    )

    console.log('✓ Test 3: openSession() rejects a sunset endpoint before the commitmentSecret check')
  } finally {
    await server.close()
  }
}

// ── Test 4: future sunset_at with no deprecated flag pays without a warning ───

{
  const future = new Date(Date.now() + 3_600_000).toISOString()
  const logs: string[] = []
  const server = await startTestServer(
    endpointManifest({ price: { method: 'GET', path: '/price', sunset_at: future } }),
  )

  try {
    const client = new RouteDockClient({
      wallet: Keypair.random(),
      network: 'testnet',
      logger: (message) => logs.push(message),
    })
    stubSubClients(client)

    const result = await client.pay(`${server.url}/price`)
    assert.equal(result.txHash, 'deadbeef')
    assert.equal(logs.some((message) => message.includes('WARNING')), false)

    console.log('✓ Test 4: future sunset_at with no deprecated flag pays and logs no WARNING')
  } finally {
    await server.close()
  }
}

// ── Test 5: a deprecated endpoint pays but logs a warning naming the path ─────

{
  const logs: string[] = []
  const server = await startTestServer(
    endpointManifest({ price: { method: 'GET', path: '/price', deprecated: true } }),
  )

  try {
    const client = new RouteDockClient({
      wallet: Keypair.random(),
      network: 'testnet',
      logger: (message) => logs.push(message),
    })
    stubSubClients(client)

    await client.pay(`${server.url}/price`)
    assert.ok(
      logs.some((message) => message.includes('WARNING') && message.includes('/price')),
      'expected a WARNING line naming the deprecated endpoint path',
    )

    console.log('✓ Test 5: a deprecated endpoint logs a WARNING naming the path')
  } finally {
    await server.close()
  }
}

// ── Test 6: query strings are ignored when matching an endpoint path ──────────

{
  const past = new Date(Date.now() - 60_000).toISOString()
  const server = await startTestServer(
    endpointManifest({ price: { method: 'GET', path: '/price', sunset_at: past } }),
  )

  try {
    const client = new RouteDockClient({ wallet: Keypair.random(), network: 'testnet' })
    stubSubClients(client)

    await assert.rejects(
      () => client.pay(`${server.url}/price?symbol=XLM`),
      (error: unknown) => error instanceof RouteDockManifestSunsetError,
    )

    console.log('✓ Test 6: query strings are ignored when matching an endpoint path')
  } finally {
    await server.close()
  }
}

// ── Test 7: a path the manifest does not list is paid normally ────────────────

{
  const past = new Date(Date.now() - 60_000).toISOString()
  const logs: string[] = []
  const server = await startTestServer(
    endpointManifest({ price: { method: 'GET', path: '/price', sunset_at: past } }),
  )

  try {
    const client = new RouteDockClient({
      wallet: Keypair.random(),
      network: 'testnet',
      logger: (message) => logs.push(message),
    })
    stubSubClients(client)

    const result = await client.pay(`${server.url}/other`)
    assert.equal(result.txHash, 'deadbeef')
    assert.equal(logs.some((message) => message.includes('WARNING')), false)

    console.log('✓ Test 7: a path the manifest does not list is paid normally')
  } finally {
    await server.close()
  }
}

// ── Test 8: shared paths reject only when every descriptor has sunset ─────────

{
  const past = new Date(Date.now() - 60_000).toISOString()

  const oneSunset = await startTestServer(
    endpointManifest({
      inferGet: { method: 'GET', path: '/infer', sunset_at: past },
      inferPost: { method: 'POST', path: '/infer' },
    }),
  )
  try {
    const client = new RouteDockClient({ wallet: Keypair.random(), network: 'testnet' })
    stubSubClients(client)

    const result = await client.pay(`${oneSunset.url}/infer`)
    assert.equal(result.txHash, 'deadbeef')
  } finally {
    await oneSunset.close()
  }

  const bothSunset = await startTestServer(
    endpointManifest({
      inferGet: { method: 'GET', path: '/infer', sunset_at: past },
      inferPost: { method: 'POST', path: '/infer', sunset_at: past },
    }),
  )
  try {
    const client = new RouteDockClient({ wallet: Keypair.random(), network: 'testnet' })
    stubSubClients(client)

    await assert.rejects(
      () => client.pay(`${bothSunset.url}/infer`),
      (error: unknown) => error instanceof RouteDockManifestSunsetError,
    )
  } finally {
    await bothSunset.close()
  }

  console.log('✓ Test 8: shared paths reject only when every descriptor has sunset')
}

// ── Test 9: a cached manifest is re-checked against the current clock ─────────

{
  const realDateNow = Date.now
  let now = 1_800_000_000_000
  Date.now = () => now

  const endpointSunset = new Date(now + 30_000).toISOString()
  const server = await startTestServer(
    endpointManifest({ price: { method: 'GET', path: '/price', sunset_at: endpointSunset } }),
  )

  try {
    const client = new RouteDockClient({ wallet: Keypair.random(), network: 'testnet' })
    stubSubClients(client)

    const result = await client.pay(`${server.url}/price`)
    assert.equal(result.txHash, 'deadbeef')

    // Still inside the 60s cache TTL, so the same manifest is reused — but the
    // endpoint sunset is now in the past and must be refused.
    now += 40_000
    await assert.rejects(
      () => client.pay(`${server.url}/price`),
      (error: unknown) => error instanceof RouteDockManifestSunsetError,
    )

    console.log('✓ Test 9: a cached manifest is re-checked against the current clock')
  } finally {
    Date.now = realDateNow
    await server.close()
  }
}

console.log('\nAll endpoint sunset tests passed.')
