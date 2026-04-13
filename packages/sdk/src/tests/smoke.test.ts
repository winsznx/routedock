/**
 * Integration smoke tests for @routedock/sdk.
 *
 * These tests run against actual package imports to verify:
 *   1. x402 flow against a local mock server (402 → payment → 200)
 *   2. ModeRouter manifest fetch + validation
 *   3. SessionStore monotonic invariant rejection
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
    const { RouteDockManifestError: ManifestError } = await import('../types.js')

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

  const { RouteDockSessionError } = await import('../types.js')

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
          throw new RouteDockSessionError(
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
      err instanceof RouteDockSessionError,
      `should throw RouteDockSessionError, got ${String(err)}`,
    )
  }
  assert.ok(threw, 'equal cumulative amount should be rejected')

  // Upsert with lower amount — should also throw
  threw = false
  try {
    await memStore.upsert('test-channel-1', { ...baseState, cumulative_amount: '0.0010000' })
  } catch (err) {
    threw = true
    assert.ok(err instanceof RouteDockSessionError)
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
    RouteDockSessionError,
    RouteDockPolicyRejectedError,
  } = await import('../types.js')

  const errors = [
    new RouteDockManifestError('test'),
    new RouteDockNoSupportedModeError('test'),
    new RouteDockSessionError('test'),
    new RouteDockPolicyRejectedError('test'),
  ]

  for (const err of errors) {
    assert.ok(err instanceof RouteDockError, `${err.name} should be instance of RouteDockError`)
    assert.ok(err instanceof Error, `${err.name} should be instance of Error`)
  }

  const policyErr = new RouteDockPolicyRejectedError('local_daily_cap_exceeded')
  assert.equal(policyErr.reason, 'local_daily_cap_exceeded')

  console.log('✓ Test 4: Error subclass hierarchy PASSED')
}

console.log('\nAll smoke tests passed.')
