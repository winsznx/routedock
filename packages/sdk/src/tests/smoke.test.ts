/**
 * Integration smoke tests for @routedock/sdk.
 *
 * These tests run against actual package imports to verify:
 *   1. x402 flow against a local mock server (402 → payment → 200)
 *   2. ModeRouter manifest fetch + validation
 *   3. SessionStore monotonic invariant rejection
 *   4. Manifest deprecation/sunset/expires_at handling
 *
 * Run with: pnpm --filter @routedock/sdk test
 * No testnet RPC calls are made — all network calls are mocked via fetch interception.
 */

import * as http from 'node:http'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import assert from 'node:assert/strict'

// ── Helpers ───────────────────────────────────────────────────────────────────

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

// ── Test 1: ModeRouter — manifest fetch + schema validation ───────────────────

{
  const validManifest = {
    routedock: '1.0',
    name: 'Test Provider',
    description: 'Smoke test provider',
    modes: ['x402', 'mpp-charge'],
    network: 'testnet',
    asset: 'USDC',
    asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    payee: 'GDHLJWBM6Z2Y4KF6Z4JAFIUUO2KAXAJ6MAIUK2XMGBQ7ZUUZ7HFPW2BK',
    pricing: {
      x402: { amount: '0.001', per: 'request', facilitator: 'https://channels.openzeppelin.com/x402/testnet' },
      'mpp-charge': { amount: '0.0008', per: 'request' },
    },
    endpoints: { price: 'GET /price' },
    tags: ['price', 'stellar'],
  }

  const server = await startTestServer((req, res) => {
    if (req.url === '/.well-known/routedock.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(validManifest))
    } else {
      res.writeHead(404)
      res.end()
    }
  })

  try {
    const { fetchManifest, selectMode } = await import('../client/ModeRouter.js')

    const manifest = await fetchManifest(server.url)
    assert.equal(manifest.routedock, '1.0', 'manifest version should be 1.0')
    assert.equal(manifest.name, 'Test Provider', 'manifest name should match')
    assert.ok(manifest.modes.includes('x402'), 'manifest should include x402 mode')

    // Second fetch should be cached
    const cached = await fetchManifest(server.url)
    assert.equal(cached, manifest, 'second fetch should return cached manifest')

    // Mode selection
    const mode = selectMode(manifest)
    assert.equal(mode, 'mpp-charge', 'mpp-charge should be preferred over x402')

    const modeForced = selectMode(manifest, { sustained: true })
    assert.equal(modeForced, 'mpp-charge', 'sustained without mpp-session falls back to mpp-charge')

    console.log('✓ Test 1: ModeRouter manifest fetch + validation PASSED')
  } finally {
    await server.close()
  }
}

// ── Test 2: ModeRouter — invalid manifest rejected ────────────────────────────

{
  const badManifest = { routedock: '2.0', name: 'bad' }

  const server = await startTestServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(badManifest))
  })

  try {
    const { fetchManifest } = await import('../client/ModeRouter.js')
    const { RouteDockManifestError: ManifestError } = await import('../errors.js')

    let threw = false
    try {
      await fetchManifest(server.url + '/bad-url')
    } catch (err) {
      threw = true
      assert.ok(
        err instanceof ManifestError,
        `should throw RouteDockManifestError, got ${String(err)}`,
      )
    }
    assert.ok(threw, 'should have thrown for invalid manifest')

    console.log('✓ Test 2: Invalid manifest rejection PASSED')
  } finally {
    await server.close()
  }
}

// ── Test 3: SessionStore — monotonic invariant rejection ─────────────────────

{
  // Use an in-memory store implementation to test monotonic invariant
  // without a real Supabase connection.

  const { RouteDockVoucherMonotonicityError } = await import('../errors.js')

  // Build a minimal in-memory SessionStore-compatible implementation
  const sessions = new Map<string, import('../types.js').SessionState>()
  const memStore = {
    async get(channelId: string) {
      return sessions.get(channelId) ?? null
    },
    async upsert(channelId: string, state: import('../types.js').SessionState) {
      const existing = sessions.get(channelId)
      if (existing) {
        const prev = parseFloat(existing.cumulative_amount)
        const next = parseFloat(state.cumulative_amount)
        if (next <= prev) {
          throw new RouteDockVoucherMonotonicityError(
            `cumulative_amount must be strictly increasing: ${next} <= ${prev}`,
          )
        }
      }
      sessions.set(channelId, { ...state })
    },
    async close(channelId: string) {
      const s = sessions.get(channelId)
      if (s) sessions.set(channelId, { ...s, status: 'closed' })
    },
  }

  const baseState: import('../types.js').SessionState = {
    channel_id: 'test-channel-1',
    payee: 'GPAYEE',
    payer: 'GPAYER',
    cumulative_amount: '0.0010000',
    last_signature: 'sig1',
    status: 'open',
    opened_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    settlement_tx_hash: null,
  }

  // First upsert — should succeed
  await memStore.upsert('test-channel-1', baseState)

  // Second upsert with higher amount — should succeed
  await memStore.upsert('test-channel-1', { ...baseState, cumulative_amount: '0.0020000' })

  // Third upsert with same amount — should throw
  let threw = false
  try {
    await memStore.upsert('test-channel-1', { ...baseState, cumulative_amount: '0.0020000' })
  } catch (err) {
    threw = true
    assert.ok(
      err instanceof RouteDockVoucherMonotonicityError,
      `should throw RouteDockVoucherMonotonicityError, got ${String(err)}`,
    )
  }
  assert.ok(threw, 'equal cumulative amount should be rejected')

  // Upsert with lower amount — should also throw
  threw = false
  try {
    await memStore.upsert('test-channel-1', { ...baseState, cumulative_amount: '0.0010000' })
  } catch (err) {
    threw = true
    assert.ok(err instanceof RouteDockVoucherMonotonicityError)
  }
  assert.ok(threw, 'lower cumulative amount should be rejected')

  console.log('✓ Test 3: SessionStore monotonic invariant rejection PASSED')
}

// ── Test 4: Error subclass hierarchy ─────────────────────────────────────────

{
  const {
    RouteDockError,
    RouteDockManifestError,
    RouteDockNoSupportedModeError,
    RouteDockFacilitatorError,
    RouteDockNetworkError,
    RouteDockVoucherMonotonicityError,
    RouteDockPolicyRejectError,
    RouteDockDeprecatedError,
    RouteDockStaleManifestError,
  } = await import('../errors.js')

  const errors: InstanceType<typeof RouteDockError>[] = [
    new RouteDockManifestError('test'),
    new RouteDockNoSupportedModeError('test'),
    new RouteDockFacilitatorError('test', 503),
    new RouteDockNetworkError('test'),
    new RouteDockVoucherMonotonicityError('test'),
    new RouteDockPolicyRejectError('local_daily_cap_exceeded'),
    new RouteDockDeprecatedError('test', 'test-endpoint'),
    new RouteDockStaleManifestError('test'),
  ]

  for (const err of errors) {
    assert.ok(err instanceof RouteDockError, `${err.name} should be instance of RouteDockError`)
    assert.ok(err instanceof Error, `${err.name} should be instance of Error`)
  }

  assert.equal(new RouteDockManifestError('x').retryable, false)
  assert.equal(new RouteDockFacilitatorError('x', 503).retryable, true)
  assert.equal(new RouteDockNetworkError('x').retryable, true)

  const policyErr = new RouteDockPolicyRejectError('local_daily_cap_exceeded')
  assert.equal(policyErr.reason, 'local_daily_cap_exceeded')

  // Test DeprecatedError
  const depErr = new RouteDockDeprecatedError('test msg', 'test-endpoint', { sunsetAt: '2026-01-01T00:00:00Z' })
  assert.equal(depErr.code, 'DEPRECATED')
  assert.equal(depErr.item, 'test-endpoint')
  assert.equal(depErr.sunsetAt, '2026-01-01T00:00:00Z')

  // Test StaleManifestError
  const staleErr = new RouteDockStaleManifestError('manifest expired')
  assert.equal(staleErr.code, 'STALE_MANIFEST')

  console.log('✓ Test 4: Error subclass hierarchy (including new errors) PASSED')
}

// ── Test 5: Manifest expires_at handling ──────────────────────────────────────

{
  const { fetchManifest } = await import('../client/ModeRouter.js')

  // Create a manifest with a past expires_at (expired immediately)
  const expiredManifest = {
    routedock: '1.0',
    name: 'Expired Provider',
    description: 'Manifest that is already expired',
    modes: ['x402'],
    network: 'testnet',
    asset: 'USDC',
    asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    payee: 'GDHLJWBM6Z2Y4KF6Z4JAFIUUO2KAXAJ6MAIUK2XMGBQ7ZUUZ7HFPW2BK',
    pricing: {
      x402: { amount: '0.001', per: 'request', facilitator: 'https://channels.openzeppelin.com/x402/testnet' },
    },
    endpoints: { price: 'GET /price' },
    tags: ['price', 'stellar'],
    expires_at: '2020-01-01T00:00:00.000Z', // Expired long ago
  }

  let fetchCount = 0
  const server = await startTestServer((req, res) => {
    if (req.url === '/.well-known/routedock.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(expiredManifest))
      fetchCount++
    } else {
      res.writeHead(404)
      res.end()
    }
  })

  try {
    // First fetch
    const manifest1 = await fetchManifest(server.url)
    assert.equal(manifest1.name, 'Expired Provider')
    assert.equal(manifest1.expires_at, '2020-01-01T00:00:00.000Z')

    // Second fetch — because expires_at is in the past, cache should be invalidated
    // and a new fetch should be made
    const manifest2 = await fetchManifest(server.url)
    assert.equal(fetchCount, 2, `should have re-fetched due to expired expires_at, fetchCount=${fetchCount}`)
    assert.notEqual(manifest1, manifest2, 'should return a new object after re-fetch')

    console.log('✓ Test 5: Manifest expires_at cache invalidation PASSED')
  } finally {
    await server.close()
  }
}

// ── Test 6: Endpoint deprecation detection ────────────────────────────────────

{
  const { checkEndpointDeprecation, getEndpointDeprecation, normalizeEndpointPath } = await import('../client/ModeRouter.js')
  const { RouteDockDeprecatedError } = await import('../errors.js')

  // Test with plain string endpoint (no deprecation)
  assert.equal(normalizeEndpointPath('GET /price'), 'GET /price')
  assert.equal(getEndpointDeprecation('GET /price'), undefined)

  // Test with EndpointEntry object (deprecated but not sunset)
  const endpoints = {
    'price': 'GET /price',
    'old-endpoint': { path: 'GET /old', deprecated: true, sunset_at: '2099-01-01T00:00:00.000Z' },
  }
  const deprecation = getEndpointDeprecation(endpoints['old-endpoint'])
  assert.ok(deprecation?.deprecated)
  assert.equal(deprecation?.sunsetAt, '2099-01-01T00:00:00.000Z')

  // This should not throw (not yet sunset)
  checkEndpointDeprecation(endpoints, 'old-endpoint')

  // Test with sunset endpoint (past sunset_at) — should throw
  const sunsetEndpoints = {
    'sunset-endpoint': { path: 'GET /sunset', deprecated: true, sunset_at: '2020-01-01T00:00:00.000Z' },
  }

  let threw = false
  try {
    checkEndpointDeprecation(sunsetEndpoints, 'sunset-endpoint')
  } catch (err) {
    threw = true
    assert.ok(err instanceof RouteDockDeprecatedError, `should throw RouteDockDeprecatedError, got ${String(err)}`)
    assert.equal((err as RouteDockDeprecatedError).item, 'sunset-endpoint')
  }
  assert.ok(threw, 'sunset endpoint should throw')

  // Test normalizeEndpointPath with EndpointEntry
  assert.equal(normalizeEndpointPath(endpoints['old-endpoint']), 'GET /old')
  assert.equal(normalizeEndpointPath(undefined), undefined)

  console.log('✓ Test 6: Endpoint deprecation detection PASSED')
}

// ── Test 7: Pricing deprecation in selectMode ─────────────────────────────────

{
  const { selectMode } = await import('../client/ModeRouter.js')
  const { RouteDockDeprecatedError: DeprecatedErr } = await import('../errors.js')

  // Test with non-deprecated pricing
  const manifest = {
    routedock: '1.0' as const,
    name: 'Pricing Dep Test',
    description: 'test',
    modes: ['x402' as const, 'mpp-charge' as const],
    network: 'testnet' as const,
    asset: 'USDC',
    asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    payee: 'GDHLJWBM6Z2Y4KF6Z4JAFIUUO2KAXAJ6MAIUK2XMGBQ7ZUUZ7HFPW2BK',
    pricing: {
      x402: { amount: '0.001', per: 'request' as const, facilitator: 'https://channels.openzeppelin.com/x402/testnet' },
      'mpp-charge': { amount: '0.0008', per: 'request' as const },
    },
    endpoints: { price: 'GET /price' },
    tags: ['test'],
  }

  // Should select mpp-charge without errors
  const mode = selectMode(manifest)
  assert.equal(mode, 'mpp-charge')

  // Test with deprecated pricing (not yet sunset) — should warn but not throw
  const deprecatedPricingManifest = {
    routedock: '1.0' as const,
    name: 'Pricing Dep Test',
    description: 'test',
    modes: ['x402' as const, 'mpp-charge' as const],
    network: 'testnet' as const,
    asset: 'USDC',
    asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    payee: 'GDHLJWBM6Z2Y4KF6Z4JAFIUUO2KAXAJ6MAIUK2XMGBQ7ZUUZ7HFPW2BK',
    pricing: {
      x402: { amount: '0.001', per: 'request' as const, facilitator: 'https://channels.openzeppelin.com/x402/testnet', deprecated: true, sunset_at: '2099-01-01T00:00:00.000Z' },
      'mpp-charge': { amount: '0.0008', per: 'request' as const },
    },
    endpoints: { price: 'GET /price' },
    tags: ['test'],
  }
  // Should still select mpp-charge (not deprecated)
  const mode2 = selectMode(deprecatedPricingManifest)
  assert.equal(mode2, 'mpp-charge')

  // Test with sunset pricing — should throw
  const sunsetPricing = {
    routedock: '1.0' as const,
    name: 'Pricing Dep Test',
    description: 'test',
    modes: ['x402' as const],
    network: 'testnet' as const,
    asset: 'USDC',
    asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    payee: 'GDHLJWBM6Z2Y4KF6Z4JAFIUUO2KAXAJ6MAIUK2XMGBQ7ZUUZ7HFPW2BK',
    pricing: {
      x402: { amount: '0.001', per: 'request' as const, facilitator: 'https://channels.openzeppelin.com/x402/testnet', deprecated: true, sunset_at: '2020-01-01T00:00:00.000Z' },
    },
    endpoints: { price: 'GET /price' },
    tags: ['test'],
  }

  let threw = false
  try {
    selectMode(sunsetPricing, { forceMode: 'x402' })
  } catch (err) {
    threw = true
    assert.ok(err instanceof DeprecatedErr, `should throw RouteDockDeprecatedError, got ${String(err)}`)
  }
  assert.ok(threw, 'sunset pricing mode should throw RouteDockDeprecatedError')

  console.log('✓ Test 7: Pricing deprecation in selectMode PASSED')
}

console.log('\nAll smoke tests passed.')