/**
 * Tests for RouteDockClient.estimateCost()
 *
 * Verifies that estimateCost:
 *   1. Resolves the manifest and returns the expected charge
 *   2. Does NOT submit any transaction (sub-clients never called)
 *   3. Respects ModeSelectOptions (forceMode, default priority)
 *   4. Surfaces RouteDockManifestError on bad URL / invalid manifest
 *   5. Does not break pay() behaviour (regression)
 *
 * Run with: pnpm --filter @routedock/routedock test
 */

import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import assert from 'node:assert/strict'
import { Keypair } from '@stellar/stellar-sdk'
import { RouteDockClient } from '../RouteDockClient.js'
import { RouteDockManifestError } from '../../errors.js'
import type { PaymentResult } from '../../types.js'

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

const BASE_MANIFEST = {
  routedock: '1.0',
  name: 'EstimateCost Test Provider',
  description: 'Provider exercised by estimateCost tests',
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

const SESSION_MANIFEST = {
  ...BASE_MANIFEST,
  modes: ['mpp-session'],
  pricing: {
    'mpp-session': {
      rate: '0.0001',
      per: 'voucher',
      channel_contract: 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH',
      min_deposit: '0.10',
      refund_waiting_period_ledgers: 17280,
    },
  },
}

// ── Test 1: resolves manifest, returns correct charge, no transaction submitted ─

{
  const server = await startTestServer((req, res) => {
    if (req.url === '/.well-known/routedock.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(BASE_MANIFEST))
    } else {
      res.writeHead(404); res.end()
    }
  })

  try {
    const client = new RouteDockClient({ wallet: Keypair.random(), network: 'testnet' })

    // Spy: assert sub-clients are never called
    let x402Called = false
    let chargePayCalled = false
    ;(client as any).x402.pay = async () => { x402Called = true }
    ;(client as any).charge.pay = async () => { chargePayCalled = true }

    const result = await client.estimateCost(`${server.url}/price`)

    // mpp-charge wins over x402 by selectMode priority
    assert.equal(result.mode, 'mpp-charge')
    assert.equal(result.amount, '0.0008')
    assert.equal(result.asset, 'USDC')
    assert.ok(result.manifest, 'manifest should be present')
    assert.equal(result.manifest.name, 'EstimateCost Test Provider')

    // Critical: no transaction was submitted
    assert.equal(x402Called, false, 'x402.pay must NOT be called by estimateCost')
    assert.equal(chargePayCalled, false, 'charge.pay must NOT be called by estimateCost')

    console.log('✓ Test 1: estimateCost returns expected charge, no transaction submitted')
  } finally {
    await server.close()
  }
}

// ── Test 2: forceMode selects the requested mode ───────────────────────────────

{
  const server = await startTestServer((req, res) => {
    if (req.url === '/.well-known/routedock.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(BASE_MANIFEST))
    } else {
      res.writeHead(404); res.end()
    }
  })

  try {
    const client = new RouteDockClient({ wallet: Keypair.random(), network: 'testnet' })

    const result = await client.estimateCost(`${server.url}/price`, { forceMode: 'x402' })

    assert.equal(result.mode, 'x402')
    assert.equal(result.amount, '0.001')
    assert.equal(result.asset, 'USDC')

    console.log('✓ Test 2: estimateCost respects forceMode option')
  } finally {
    await server.close()
  }
}

// ── Test 3: mpp-session manifest returns rate (per voucher) ───────────────────

{
  const server = await startTestServer((req, res) => {
    if (req.url === '/.well-known/routedock.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(SESSION_MANIFEST))
    } else {
      res.writeHead(404); res.end()
    }
  })

  try {
    const client = new RouteDockClient({ wallet: Keypair.random(), network: 'testnet' })

    const result = await client.estimateCost(`${server.url}/stream`, { session: true })

    assert.equal(result.mode, 'mpp-session')
    assert.equal(result.amount, '0.0001')
    // Full manifest is present for approval-gate use (e.g. min_deposit)
    assert.equal(
      (result.manifest.pricing['mpp-session'] as any)?.min_deposit,
      '0.10',
      'min_deposit should be accessible via manifest',
    )

    console.log('✓ Test 3: estimateCost handles mpp-session, returns voucher rate')
  } finally {
    await server.close()
  }
}

// ── Test 4: invalid manifest throws RouteDockManifestError ────────────────────

{
  const server = await startTestServer((req, res) => {
    if (req.url === '/.well-known/routedock.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ routedock: '2.0', name: 'bad' }))
    } else {
      res.writeHead(404); res.end()
    }
  })

  try {
    const client = new RouteDockClient({ wallet: Keypair.random(), network: 'testnet' })

    let threw = false
    try {
      await client.estimateCost(`${server.url}/price`)
    } catch (err) {
      threw = true
      assert.ok(
        err instanceof RouteDockManifestError,
        `expected RouteDockManifestError, got ${String(err)}`,
      )
    }
    assert.ok(threw, 'should have thrown for invalid manifest schema')

    console.log('✓ Test 4: estimateCost throws RouteDockManifestError on invalid manifest')
  } finally {
    await server.close()
  }
}

// ── Test 5: 404 manifest throws RouteDockManifestError ────────────────────────

{
  const server = await startTestServer((_req, res) => {
    res.writeHead(404); res.end()
  })

  try {
    const client = new RouteDockClient({ wallet: Keypair.random(), network: 'testnet' })

    let threw = false
    try {
      await client.estimateCost(`${server.url}/price`)
    } catch (err) {
      threw = true
      assert.ok(
        err instanceof RouteDockManifestError,
        `expected RouteDockManifestError, got ${String(err)}`,
      )
    }
    assert.ok(threw, 'should have thrown for 404 manifest')

    console.log('✓ Test 5: estimateCost throws RouteDockManifestError on 404')
  } finally {
    await server.close()
  }
}

// ── Test 6: pay() regression — still works correctly after refactor ────────────

{
  const server = await startTestServer((req, res) => {
    if (req.url === '/.well-known/routedock.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(BASE_MANIFEST))
    } else {
      res.writeHead(404); res.end()
    }
  })

  try {
    const client = new RouteDockClient({ wallet: Keypair.random(), network: 'testnet' })

    const fakeResult: PaymentResult = {
      data: { ok: true },
      txHash: 'deadbeef',
      mode: 'mpp-charge',
      amount: '0.0008',
      timestamp: Date.now(),
    }
    ;(client as any).charge.pay = async () => fakeResult

    const result = await client.pay(`${server.url}/price`)

    assert.equal(result.mode, 'mpp-charge')
    assert.equal(result.amount, '0.0008')
    assert.equal(result.txHash, 'deadbeef')

    console.log('✓ Test 6: pay() regression — works correctly after _resolveManifest refactor')
  } finally {
    await server.close()
  }
}

console.log('\nAll estimateCost tests passed.')
