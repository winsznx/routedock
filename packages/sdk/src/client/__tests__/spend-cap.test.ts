/**
 * Tests for Issue #130: Local daily spend cap security fixes.
 *
 * Verifies:
 *   (a) Spend cap is checked BEFORE payment executes (pre-payment check)
 *   (b) Concurrent pay() calls are serialized via the spend mutex
 *   (c) MPP session voucher spend consults the cap
 *   (d) Rollback of reservation when payment fails
 *   (e) Endpoint caps are enforced
 *
 * Run with: pnpm --filter @routedock/routedock test
 */

import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import assert from 'node:assert/strict'
import { Keypair } from '@stellar/stellar-sdk'
import { RouteDockClient, usdcToMicros } from '../RouteDockClient.js'
import { InMemorySpendStore, FileSpendStore } from '../../store/SpendStore.js'
import { RouteDockPolicyRejectError } from '../../errors.js'
import { signManifest } from '../../manifest/sign.js'
import type { RouteDockManifest, PaymentResult } from '../../types.js'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rmSync } from 'node:fs'

// ── Helpers ───────────────────────────────────────────────────────────────────

const PAYEE_KEYPAIR = Keypair.random()

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

function makeManifest(
  opts: Partial<{
    modes: Array<'x402' | 'mpp-charge' | 'mpp-session'>
    mppChargeAmount: string
    sessionRate: string
  }> = {},
): { manifest: RouteDockManifest; url: string } {
  const modes = opts.modes ?? ['x402', 'mpp-charge']
  const pricing: RouteDockManifest['pricing'] = {}

  if (modes.includes('x402')) {
    pricing.x402 = { amount: '0.001', per: 'request', facilitator: 'https://channels.openzeppelin.com/x402/testnet' }
  }
  if (modes.includes('mpp-charge')) {
    pricing['mpp-charge'] = { amount: opts.mppChargeAmount ?? '0.0008', per: 'request' }
  }
  if (modes.includes('mpp-session')) {
    pricing['mpp-session'] = {
      rate: opts.sessionRate ?? '0.0001',
      per: 'voucher',
      channel_factory: 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH',
      min_deposit: '0.10',
      refund_waiting_period_ledgers: 17280,
    }
  }

  const manifest = signManifest({
    routedock: '1.0',
    name: 'Spend Cap Test Provider',
    description: 'Provider for spend cap tests',
    modes,
    network: 'testnet',
    asset: 'USDC',
    asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    payee: PAYEE_KEYPAIR.publicKey(),
    pricing,
    endpoints: { test: { method: 'GET', path: '/test' } },
    tags: ['test'],
  }, PAYEE_KEYPAIR.secret())

  return { manifest, url: `http://test-${Keypair.random().publicKey().slice(0, 8)}.example.com` }
}

function makeManifestHandler(manifest: RouteDockManifest) {
  return (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/.well-known/routedock.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(manifest))
    } else {
      res.writeHead(404); res.end()
    }
  }
}

function stubTrustlineCache(client: RouteDockClient): void {
  const keypair = (client as any).keypair as Keypair
  const network = (client as any).network as string
  const cacheKey = `${network}:${keypair.publicKey()}:USDC`
  ;(RouteDockClient as any)._trustlineCache.set(cacheKey, {
    exists: true,
    expiresAt: Date.now() + 300_000,
  })
}

function fakeResult(mode: string, amount: string): PaymentResult {
  return {
    data: { ok: true },
    txHash: 'deadbeef',
    mode: mode as any,
    amount,
    timestamp: Date.now(),
  }
}

// ── Test 1: Spend cap is checked BEFORE payment executes ──────────────────────

{
  const { manifest } = makeManifest()
  const server = await startTestServer(makeManifestHandler(manifest))

  try {
    const store = new InMemorySpendStore({ warn: false })
    const client = new RouteDockClient({
      wallet: Keypair.random(),
      network: 'testnet',
      spendCap: { daily: '0.0015', asset: 'USDC' },
      spendStore: store,
    })
    stubTrustlineCache(client)

    let chargePayCalled = false
    ;(client as any).charge.pay = async () => { chargePayCalled = true; return fakeResult('mpp-charge', '0.0008') }

    // First call should succeed (0.0008 <= 0.0015)
    await client.pay(`${server.url}/test`)
    assert.equal(chargePayCalled, true, 'first pay() should execute')

    // Second call should also succeed (0.0008 + 0.0008 = 0.0016 > 0.0015)
    // With the fix, this should throw BEFORE charge.pay is called
    chargePayCalled = false
    let threw = false
    try {
      await client.pay(`${server.url}/test`)
    } catch (err) {
      threw = true
      assert.ok(err instanceof RouteDockPolicyRejectError)
    }
    assert.ok(threw, 'second pay() should throw when over cap')
    assert.equal(chargePayCalled, false, 'charge.pay must NOT be called when cap is exceeded')

    // Spend should only reflect the first successful payment
    const state = await store.read()
    assert.ok(state)
    assert.equal(state.totalMicros, '8000', 'only first payment should be recorded')

    console.log('✓ Test 1: Spend cap is checked BEFORE payment executes (no per-call drain)')
  } finally {
    await server.close()
  }
}

// ── Test 2: Concurrent pay() calls are serialized via mutex ────────────────────

{
  const { manifest } = makeManifest()
  const server = await startTestServer(makeManifestHandler(manifest))

  try {
    const store = new InMemorySpendStore({ warn: false })
    const client = new RouteDockClient({
      wallet: Keypair.random(),
      network: 'testnet',
      spendCap: { daily: '0.0015', asset: 'USDC' },
      spendStore: store,
    })
    stubTrustlineCache(client)

    let callOrder: number[] = []
    let counter = 0
    ;(client as any).charge.pay = async () => {
      const id = ++counter
      callOrder.push(id)
      await new Promise((r) => setTimeout(r, 5))
      return fakeResult('mpp-charge', '0.0008')
    }

    // Launch 3 concurrent pay() calls.
    // With a mutex, only 1 should succeed (0.0008 <= 0.0015),
    // the second should fail (0.0016 > 0.0015), and the third too.
    const results = await Promise.allSettled([
      client.pay(`${server.url}/test`),
      client.pay(`${server.url}/test`),
      client.pay(`${server.url}/test`),
    ])

    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')

    assert.ok(fulfilled.length >= 1, 'at least one concurrent call should succeed')
    assert.ok(rejected.length >= 1, 'at least one concurrent call should be rejected')

    // Spend should not exceed the cap
    const state = await store.read()
    assert.ok(state)
    const total = BigInt(state.totalMicros)
    assert.ok(total <= 15000n, `total spend ${total} should not exceed cap 15000`)

    console.log(`✓ Test 2: Concurrent pay() calls serialized — ${fulfilled.length} succeeded, ${rejected.length} rejected`)
  } finally {
    await server.close()
  }
}

// ── Test 3: Rollback on payment failure ───────────────────────────────────────

{
  const { manifest } = makeManifest()
  const server = await startTestServer(makeManifestHandler(manifest))

  try {
    const store = new InMemorySpendStore({ warn: false })
    const client = new RouteDockClient({
      wallet: Keypair.random(),
      network: 'testnet',
      spendCap: { daily: '0.002', asset: 'USDC' },
      spendStore: store,
    })
    stubTrustlineCache(client)

    // First call fails — should rollback
    ;(client as any).charge.pay = async () => {
      throw new Error('payment failed')
    }
    let threw = false
    try {
      await client.pay(`${server.url}/test`)
    } catch {
      threw = true
    }
    assert.ok(threw, 'first pay() should throw')

    // Spend should be rolled back to zero
    const stateAfterFail = await store.read()
    assert.ok(stateAfterFail)
    assert.equal(stateAfterFail.totalMicros, '0', 'spend should be rolled back after failure')

    // Second call succeeds — should work because spend was rolled back
    ;(client as any).charge.pay = async () => fakeResult('mpp-charge', '0.001')
    const result = await client.pay(`${server.url}/test`)
    assert.equal(result.amount, '0.001', 'second pay() should succeed after rollback')

    const stateAfterSuccess = await store.read()
    assert.ok(stateAfterSuccess)
    assert.equal(stateAfterSuccess.totalMicros, '8000', 'spend should reflect only the successful payment')

    console.log('✓ Test 3: Spend reservation is rolled back on payment failure')
  } finally {
    await server.close()
  }
}

// ── Test 4: Endpoint caps are enforced ────────────────────────────────────────

{
  const { manifest } = makeManifest()
  const server = await startTestServer(makeManifestHandler(manifest))

  try {
    const store = new InMemorySpendStore({ warn: false })
    const client = new RouteDockClient({
      wallet: Keypair.random(),
      network: 'testnet',
      spendCap: {
        daily: '1.00',
        asset: 'USDC',
        endpointCaps: { [server.url]: '0.0015' },
      },
      spendStore: store,
    })
    stubTrustlineCache(client)

    let chargePayCalled = false
    ;(client as any).charge.pay = async () => { chargePayCalled = true; return fakeResult('mpp-charge', '0.0008') }

    // First call succeeds (0.0008 <= 0.0015 endpoint cap)
    await client.pay(`${server.url}/test`)
    assert.equal(chargePayCalled, true)

    // Second call exceeds endpoint cap (0.0008 + 0.0008 = 0.0016 > 0.0015)
    chargePayCalled = false
    let threw = false
    try {
      await client.pay(`${server.url}/test`)
    } catch (err) {
      threw = true
      assert.ok(err instanceof RouteDockPolicyRejectError)
      assert.equal((err as RouteDockPolicyRejectError).reason, 'local_endpoint_cap_exceeded')
    }
    assert.ok(threw, 'should throw on endpoint cap exceeded')
    assert.equal(chargePayCalled, false, 'charge.pay must NOT be called when endpoint cap is exceeded')

    console.log('✓ Test 4: Endpoint caps are enforced independently of global cap')
  } finally {
    await server.close()
  }
}

// ── Test 5: MPP session voucher spend consults the cap ────────────────────────

// Test 5a: RouteDockClient passes onSpend to MppSessionClient when spendCap is set
{
  const { manifest } = makeManifest({ modes: ['mpp-session'], sessionRate: '0.0001' })
  const server = await startTestServer(makeManifestHandler(manifest))

  try {
    const store = new InMemorySpendStore({ warn: false })
    const client = new RouteDockClient({
      wallet: Keypair.random(),
      network: 'testnet',
      spendCap: { daily: '0.001', asset: 'USDC' },
      commitmentSecret: Keypair.random().secret(),
      spendStore: store,
    })
    stubTrustlineCache(client)

    let onSpendPassed = false
    const origOpenSession = (client as any).session.openSession.bind((client as any).session)
    ;(client as any).session.openSession = async (url: string, manifest: any, secret: string, opts: any, onSpend?: any) => {
      onSpendPassed = onSpend !== undefined && typeof onSpend === 'function'
      return origOpenSession(url, manifest, secret, opts, onSpend)
    }

    const handle = await client.openSession(`${server.url}/stream`, { maxDurationMs: 0 })
    assert.ok(onSpendPassed, 'onSpend callback should be passed when spendCap is set')
    assert.equal(handle.channelId, manifest.pricing['mpp-session']!.channel_factory)

    console.log('✓ Test 5a: RouteDockClient passes onSpend to MppSessionClient when spendCap is set')
  } finally {
    await server.close()
  }
}

// Test 5b: _recordSessionSpend enforces cap (called by onSpend before each voucher)
{
  const store = new InMemorySpendStore({ warn: false })
  const client = new RouteDockClient({
    wallet: Keypair.random(),
    network: 'testnet',
    spendCap: { daily: '0.0005', asset: 'USDC' },
    spendStore: store,
  })

  // _recordSessionSpend is private; access via any for testing
  const record = (amount: string) => (client as any)._recordSessionSpend(amount, 'https://api.test.com') as Promise<void>

  // Record 5 vouchers at 0.0001 each (total 0.0005 — at cap)
  for (let i = 0; i < 5; i++) {
    await record('0.0001')
  }

  const state = await store.read()
  assert.ok(state)
  assert.equal(state.totalMicros, '5000', '5 vouchers at 0.0001 should equal 5000 microUSDC')

  // 6th voucher should exceed cap
  let threw = false
  try {
    await record('0.0001')
  } catch (err) {
    threw = true
    assert.ok(err instanceof RouteDockPolicyRejectError)
  }
  assert.ok(threw, '6th voucher should exceed daily cap')

  console.log('✓ Test 5b: Session voucher spend enforced via _recordSessionSpend')
}

// ── Test 6: No cap enforcement when spendCap is undefined ─────────────────────

{
  const { manifest } = makeManifest()
  const server = await startTestServer(makeManifestHandler(manifest))

  try {
    const client = new RouteDockClient({
      wallet: Keypair.random(),
      network: 'testnet',
      // No spendCap
    })
    stubTrustlineCache(client)

    let callCount = 0
    ;(client as any).charge.pay = async () => { callCount++; return fakeResult('mpp-charge', '0.0008') }

    // Should never throw when no cap is configured
    for (let i = 0; i < 10; i++) {
      await client.pay(`${server.url}/test`)
    }
    assert.equal(callCount, 10, 'all 10 calls should succeed without a spend cap')

    console.log('✓ Test 6: No cap enforcement when spendCap is undefined')
  } finally {
    await server.close()
  }
}

// ── Test 7: Rollback restores endpoint spend ──────────────────────────────────

{
  const { manifest } = makeManifest({ mppChargeAmount: '0.0003' })
  const server = await startTestServer(makeManifestHandler(manifest))

  try {
    const store = new InMemorySpendStore({ warn: false })
    const client = new RouteDockClient({
      wallet: Keypair.random(),
      network: 'testnet',
      spendCap: {
        daily: '1.00',
        asset: 'USDC',
        endpointCaps: { [server.url]: '0.001' },
      },
      spendStore: store,
    })
    stubTrustlineCache(client)

    // First call succeeds (0.0003 = 3000 microUSDC)
    ;(client as any).charge.pay = async () => fakeResult('mpp-charge', '0.0003')
    await client.pay(`${server.url}/test`)

    let state = await store.read()
    assert.ok(state)
    assert.equal(state.totalMicros, '3000')
    assert.equal(state.endpoints[server.url], '3000')

    // Second call fails — should rollback
    ;(client as any).charge.pay = async () => { throw new Error('payment failed') }
    try {
      await client.pay(`${server.url}/test`)
    } catch {}

    state = await store.read()
    assert.ok(state)
    assert.equal(state.totalMicros, '3000', 'total should be rolled back to pre-failure value')
    assert.equal(state.endpoints[server.url], '3000', 'endpoint spend should be rolled back')

    // Third call succeeds — endpoint cap still allows it (3000 + 3000 = 6000 < 10000)
    ;(client as any).charge.pay = async () => fakeResult('mpp-charge', '0.0003')
    await client.pay(`${server.url}/test`)

    state = await store.read()
    assert.ok(state)
    assert.equal(state.totalMicros, '6000', 'total should reflect first + third payment')
    assert.equal(state.endpoints[server.url], '6000', 'endpoint should reflect first + third payment')

    console.log('✓ Test 7: Rollback correctly restores both global and endpoint spend')
  } finally {
    await server.close()
  }
}

// ── Test 8: usdcToMicros precision ────────────────────────────────────────────

{
  assert.equal(usdcToMicros('1.00').toString(), '10000000')
  assert.equal(usdcToMicros('0.0000001').toString(), '1')
  assert.equal(usdcToMicros('0.0001').toString(), '1000')
  assert.equal(usdcToMicros('0.001').toString(), '10000')
  assert.equal(usdcToMicros('0.01').toString(), '100000')

  // 8 decimal places should throw
  let threw = false
  try {
    usdcToMicros('0.00000001')
  } catch {
    threw = true
  }
  assert.ok(threw, 'usdcToMicros should reject amounts with more than 7 decimal places')

  console.log('✓ Test 8: usdcToMicros handles precision correctly')
}

// ── Test 9: FileSpendStore durability ────────────────────────────────────────

{
  const tmpPath = join(tmpdir(), `routedock-test-spend-${Date.now()}.json`)
  try {
    const store = new FileSpendStore(tmpPath)
    assert.equal(await store.read(), null, 'non-existent store should return null')

    const state = {
      date: '2026-08-26',
      totalMicros: '5000000',
      endpoints: { 'https://api.example.com': '5000000' },
    }

    await store.write(state)

    // Second store reading the same file
    const store2 = new FileSpendStore(tmpPath)
    const readState = await store2.read()
    assert.ok(readState)
    assert.equal(readState.date, '2026-08-26')
    assert.equal(readState.totalMicros, '5000000')
    assert.equal(readState.endpoints['https://api.example.com'], '5000000')

    console.log('✓ Test 9: FileSpendStore persists and reads spend accumulator across instances')
  } finally {
    try {
      rmSync(tmpPath)
    } catch {}
  }
}

console.log('\nAll spend-cap tests passed.')

