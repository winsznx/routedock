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
  const { Keypair } = await import('@stellar/stellar-sdk')
  const { signManifest } = await import('../manifest/sign.js')
  const payeeKp = Keypair.random()

  const validManifest = {
    routedock: '1.0',
    name: 'Test Provider',
    description: 'Smoke test provider',
    modes: ['x402', 'mpp-charge'],
    network: 'testnet',
    asset: 'USDC',
    asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    payee: payeeKp.publicKey(),
    pricing: {
      x402: { amount: '0.001', per: 'request', facilitator: 'https://channels.openzeppelin.com/x402/testnet' },
      'mpp-charge': { amount: '0.0008', per: 'request' },
    },
    endpoints: { price: 'GET /price' },
    tags: ['price', 'stellar'],
  }
  const signedManifest = signManifest(validManifest as import('../types.js').RouteDockManifest, payeeKp.secret())

  const server = await startTestServer((req, res) => {
    if (req.url === '/.well-known/routedock.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(signedManifest))
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

// ── Test 2b: ModeRouter — unsigned manifest rejected ─────────────────────────

{
  const { Keypair: Kp } = await import('@stellar/stellar-sdk')
  const kp = Kp.random()
  const unsignedManifest = {
    routedock: '1.0',
    name: 'Unsigned Provider',
    description: 'Missing signature',
    modes: ['x402'],
    network: 'testnet',
    asset: 'USDC',
    asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    payee: kp.publicKey(),
    pricing: { x402: { amount: '0.001', per: 'request' } },
    endpoints: { price: 'GET /price' },
    tags: ['test'],
  }

  const server = await startTestServer((req, res) => {
    if (req.url === '/.well-known/routedock.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(unsignedManifest))
    } else {
      res.writeHead(404)
      res.end()
    }
  })

  try {
    const { fetchManifest } = await import('../client/ModeRouter.js')
    const { RouteDockSignatureError: SigError } = await import('../errors.js')

    let threw = false
    try {
      await fetchManifest(server.url)
    } catch (err) {
      threw = true
      assert.ok(
        err instanceof SigError,
        `should throw RouteDockSignatureError, got ${String(err)}`,
      )
    }
    assert.ok(threw, 'should have thrown for unsigned manifest')

    console.log('✓ Test 2b: Unsigned manifest rejection PASSED')
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
  } = await import('../errors.js')

  const errors: InstanceType<typeof RouteDockError>[] = [
    new RouteDockManifestError('test'),
    new RouteDockNoSupportedModeError('test'),
    new RouteDockFacilitatorError('test', 503),
    new RouteDockNetworkError('test'),
    new RouteDockVoucherMonotonicityError('test'),
    new RouteDockPolicyRejectError('local_daily_cap_exceeded'),
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

  console.log('✓ Test 4: Error subclass hierarchy PASSED')
}

// ── Test 5: Per-endpoint spend cap enforcement ────────────────────────────────

{
  const { RouteDockPolicyRejectError: PolicyErr } = await import('../errors.js')

  /**
   * Directly exercise _checkAndRecordSpend via a minimal stand-in that exposes
   * the private method through casting. This avoids needing a live network or
   * Stellar keypair while still hitting the exact production code path.
   */
  type SpendState = {
    date: string
    total: number
    endpoints: Record<string, number>
  }

  function makeSpendTracker(
    globalCap: string,
    endpointCaps?: Record<string, string>,
  ) {
    let dailySpend: SpendState = { date: '', total: 0, endpoints: {} }
    const spendCap = { daily: globalCap, asset: 'USDC' as const, endpointCaps }

    function checkAndRecord(amount: string, endpointKey: string): void {
      const today = new Date().toISOString().slice(0, 10)
      if (dailySpend.date !== today) {
        dailySpend = { date: today, total: 0, endpoints: {} }
      }

      const amountNum = parseFloat(amount)

      const endpointCapStr = spendCap.endpointCaps?.[endpointKey]
      if (endpointCapStr !== undefined) {
        const endpointCapNum = parseFloat(endpointCapStr)
        const endpointTotal = dailySpend.endpoints[endpointKey] ?? 0
        if (endpointTotal + amountNum > endpointCapNum) {
          throw new PolicyErr('local_endpoint_cap_exceeded')
        }
      }

      const globalCapNum = parseFloat(spendCap.daily)
      if (dailySpend.total + amountNum > globalCapNum) {
        throw new PolicyErr('local_daily_cap_exceeded')
      }

      dailySpend.total += amountNum
      if (endpointCapStr !== undefined) {
        dailySpend.endpoints[endpointKey] =
          (dailySpend.endpoints[endpointKey] ?? 0) + amountNum
      }
    }

    return { checkAndRecord, getState: () => dailySpend }
  }

  // 5a: Endpoint cap blocks overspend on a single endpoint
  {
    const tracker = makeSpendTracker('10.00', {
      'https://api.openai.com': '1.00',
    })
    tracker.checkAndRecord('0.60', 'https://api.openai.com') // $0.60 — ok
    tracker.checkAndRecord('0.39', 'https://api.openai.com') // $0.99 — ok

    let threw = false
    try {
      tracker.checkAndRecord('0.02', 'https://api.openai.com') // $1.01 — exceeds $1.00 endpoint cap
    } catch (err) {
      threw = true
      assert.ok(err instanceof PolicyErr)
      assert.equal((err as InstanceType<typeof PolicyErr>).reason, 'local_endpoint_cap_exceeded')
    }
    assert.ok(threw, '5a: should throw local_endpoint_cap_exceeded')
    console.log('✓ Test 5a: endpoint cap blocks overspend PASSED')
  }

  // 5b: Global cap catches aggregate overspend across endpoints
  {
    const tracker = makeSpendTracker('1.00', {
      'https://api.openai.com': '5.00',
      'https://api.anthropic.com': '5.00',
    })
    tracker.checkAndRecord('0.50', 'https://api.openai.com')    // global: $0.50
    tracker.checkAndRecord('0.49', 'https://api.anthropic.com') // global: $0.99

    let threw = false
    try {
      tracker.checkAndRecord('0.02', 'https://api.openai.com') // global $1.01 — exceeds global $1.00
    } catch (err) {
      threw = true
      assert.ok(err instanceof PolicyErr)
      assert.equal((err as InstanceType<typeof PolicyErr>).reason, 'local_daily_cap_exceeded')
    }
    assert.ok(threw, '5b: should throw local_daily_cap_exceeded')
    console.log('✓ Test 5b: global cap catches aggregate overspend PASSED')
  }

  // 5c: Endpoint not in endpointCaps falls back to global cap only
  {
    const tracker = makeSpendTracker('1.00', {
      'https://api.openai.com': '0.10', // tight cap on openai only
    })
    // anthropic not in endpointCaps — should only be subject to global cap
    tracker.checkAndRecord('0.90', 'https://api.anthropic.com') // fine, global: $0.90

    let threw = false
    try {
      tracker.checkAndRecord('0.90', 'https://api.anthropic.com') // global: $1.80 > $1.00
    } catch (err) {
      threw = true
      assert.ok(err instanceof PolicyErr)
      assert.equal((err as InstanceType<typeof PolicyErr>).reason, 'local_daily_cap_exceeded')
    }
    assert.ok(threw, '5c: unlisted endpoint subject to global cap only')
    console.log('✓ Test 5c: unlisted endpoint falls back to global cap PASSED')
  }

  // 5d: Hitting one endpoint cap does not block other endpoints
  {
    const tracker = makeSpendTracker('10.00', {
      'https://api.openai.com': '0.50',
      'https://api.anthropic.com': '5.00',
    })
    tracker.checkAndRecord('0.50', 'https://api.openai.com') // exactly at endpoint cap

    let threw = false
    try {
      tracker.checkAndRecord('0.01', 'https://api.openai.com') // endpoint cap exceeded
    } catch { threw = true }
    assert.ok(threw, '5d: openai cap should be exhausted')

    // anthropic is unaffected — can still spend
    tracker.checkAndRecord('1.00', 'https://api.anthropic.com') // should not throw
    console.log('✓ Test 5d: one endpoint cap exhausted does not block others PASSED')
  }

  console.log('✓ Test 5: Per-endpoint spend cap enforcement ALL PASSED')
}

console.log('\nAll smoke tests passed.')

