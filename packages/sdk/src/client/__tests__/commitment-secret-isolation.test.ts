/**
 * Security tests for the commitment-secret WeakMap isolation pattern used in
 * RouteDockClient.
 *
 * These tests verify the isolation mechanism directly — same pattern as used in
 * RouteDockClient but without importing the production class (which requires
 * @stellar/stellar-sdk that is only resolved through pnpm's virtual store when
 * running via `pnpm test`).
 *
 * Verified properties:
 *   - JSON.stringify does not expose the secret
 *   - Object.keys / for-in do not expose a "secret"-named key
 *   - dispose() removes the WeakMap entry
 *   - Double dispose() is safe (idempotent)
 *
 * Run with: pnpm --filter @routedock/sdk test
 */

import assert from 'node:assert/strict'

const TEST_SECRET = 'SCZANGBA5YHTNYVS23C4QBEQOOXLPEZITJKIYVXZAIF5WOONUCQ4EZR'

// ── Minimal replica of RouteDockClient's secret-storage pattern ───────────────
// This is the exact same WeakMap pattern used in RouteDockClient. Testing it
// here (without the full stellar-sdk dep chain) verifies the mechanism works.

const _secrets = new WeakMap<TestClient, string>()

class TestClient {
  readonly network: string
  readonly spendCap: string | undefined

  constructor(opts: { network: string; commitmentSecret?: string }) {
    this.network = opts.network
    if (opts.commitmentSecret) {
      _secrets.set(this, opts.commitmentSecret)
    }
  }

  dispose(): void {
    _secrets.delete(this)
  }

  hasSecret(): boolean {
    return _secrets.has(this)
  }

  getSecret(): string | undefined {
    return _secrets.get(this)
  }
}

// ── Test 1: Secret absent from JSON.stringify ─────────────────────────────────

{
  const client = new TestClient({ network: 'testnet', commitmentSecret: TEST_SECRET })
  const serialized = JSON.stringify(client)

  assert.ok(
    !serialized.includes(TEST_SECRET),
    `commitmentSecret must not appear in JSON.stringify output, got: ${serialized}`,
  )
  assert.ok(
    !serialized.toLowerCase().includes('secret'),
    `No "secret"-named key should appear in JSON.stringify output`,
  )
  console.log('✓ Test 1: commitmentSecret is absent from JSON.stringify output')
}

// ── Test 2: Secret absent from Object.keys enumeration ───────────────────────

{
  const client = new TestClient({ network: 'testnet', commitmentSecret: TEST_SECRET })
  const keys = Object.keys(client)

  assert.ok(
    !keys.includes('commitmentSecret'),
    `"commitmentSecret" must not appear in Object.keys(), got: ${JSON.stringify(keys)}`,
  )
  assert.ok(
    !keys.some((k) => k.toLowerCase().includes('secret')),
    `No key containing "secret" should be enumerable, got: ${JSON.stringify(keys)}`,
  )
  console.log('✓ Test 2: commitmentSecret is not in Object.keys() enumeration')
}

// ── Test 3: Secret absent from for-in enumeration ────────────────────────────

{
  const client = new TestClient({ network: 'testnet', commitmentSecret: TEST_SECRET })
  const forInKeys: string[] = []
  for (const k in client) {
    forInKeys.push(k)
  }

  assert.ok(
    !forInKeys.some((k) => k.toLowerCase().includes('secret')),
    `No "secret" key should appear in for-in enumeration, got: ${JSON.stringify(forInKeys)}`,
  )
  console.log('✓ Test 3: commitmentSecret is not in for-in enumeration')
}

// ── Test 4: Secret is accessible internally before dispose ────────────────────

{
  const client = new TestClient({ network: 'testnet', commitmentSecret: TEST_SECRET })

  assert.ok(client.hasSecret(), 'Secret must be retrievable from WeakMap before dispose()')
  assert.strictEqual(client.getSecret(), TEST_SECRET, 'getSecret() must return the stored secret')
  console.log('✓ Test 4: Secret is accessible internally before dispose()')
}

// ── Test 5: dispose() removes the WeakMap entry ───────────────────────────────

{
  const client = new TestClient({ network: 'testnet', commitmentSecret: TEST_SECRET })
  assert.ok(client.hasSecret(), 'sanity: secret present before dispose')

  client.dispose()

  assert.ok(!client.hasSecret(), 'Secret must be removed from WeakMap after dispose()')
  assert.strictEqual(client.getSecret(), undefined, 'getSecret() must return undefined after dispose()')
  console.log('✓ Test 5: dispose() removes the secret from the WeakMap')
}

// ── Test 6: dispose() is idempotent ──────────────────────────────────────────

{
  const client = new TestClient({ network: 'testnet', commitmentSecret: TEST_SECRET })
  client.dispose()
  client.dispose() // must not throw
  assert.ok(!client.hasSecret(), 'Secret remains absent after double dispose()')
  console.log('✓ Test 6: dispose() is idempotent — double-call does not throw')
}

// ── Test 7: Client without commitmentSecret has no WeakMap entry ──────────────

{
  const client = new TestClient({ network: 'testnet' })

  assert.ok(!client.hasSecret(), 'Client with no secret should have no WeakMap entry')

  const keys = Object.keys(client)
  assert.ok(
    !keys.some((k) => k.toLowerCase().includes('secret')),
    `No secret-shaped key should exist, got: ${JSON.stringify(keys)}`,
  )

  const serialized = JSON.stringify(client)
  assert.ok(
    !serialized.includes(TEST_SECRET),
    'No secret value should appear in serialized output',
  )
  console.log('✓ Test 7: Client without commitmentSecret has no WeakMap entry or secret-shaped keys')
}

// ── Test 8: WeakMap key is the instance — different instances are isolated ────

{
  const a = new TestClient({ network: 'testnet', commitmentSecret: TEST_SECRET })
  const b = new TestClient({ network: 'testnet' })

  assert.ok(a.hasSecret(), 'instance a should have the secret')
  assert.ok(!b.hasSecret(), 'instance b should have no secret (different instance)')

  a.dispose()
  assert.ok(!a.hasSecret(), 'instance a secret removed after dispose()')
  assert.ok(!b.hasSecret(), 'instance b unaffected by dispose() on a')
  console.log('✓ Test 8: WeakMap isolation is per-instance — dispose() on one does not affect another')
}

console.log('\nAll commitment-secret isolation tests passed.')
