/**
 * Tests for the manifest-timeout mechanism against real SDK functions:
 *   1. fetchManifest(url, { timeoutMs }) rejects with RouteDockManifestTimeoutError on a hanging server
 *   2. RouteDockManifestTimeoutError has the correct code, retryable flag, and cause
 *   3. RouteDockClient.estimateCost(url) propagates manifestTimeoutMs and rejects with RouteDockManifestTimeoutError
 *
 * Run with: pnpm --filter @routedock/routedock test
 */

import * as http from 'node:http'
import assert from 'node:assert/strict'
import { Keypair } from '@stellar/stellar-sdk'
import { RouteDockManifestTimeoutError } from '../../errors.js'
import { fetchManifest } from '../ModeRouter.js'
import { RouteDockClient } from '../RouteDockClient.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function startHangingServer(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const sockets = new Set<import('node:net').Socket>()
    const server = http.createServer((_req, _res) => {
      // Intentionally never respond — simulates a slow/stuck provider.
    })
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((res) => {
            for (const s of sockets) s.destroy()
            server.close(() => res())
          }),
      })
    })
  })
}

// ── Test 1: fetchManifest rejects with RouteDockManifestTimeoutError on a hanging server ──

{
  const server = await startHangingServer()
  try {
    const TIMEOUT_MS = 150
    const start = Date.now()
    let caught: unknown
    try {
      await fetchManifest(server.url, { maxAttempts: 1 }, TIMEOUT_MS)
    } catch (err) {
      caught = err
    }

    const elapsed = Date.now() - start
    assert.ok(
      caught instanceof RouteDockManifestTimeoutError,
      `fetchManifest must reject with RouteDockManifestTimeoutError, got ${String(caught)}`,
    )
    assert.strictEqual(caught.code, 'MANIFEST_TIMEOUT')
    assert.strictEqual(caught.retryable, true)
    assert.ok(caught.cause instanceof Error, 'cause must be preserved')
    assert.ok(elapsed < 2000, `Should abort quickly, took ${elapsed}ms`)
    console.log(`✓ Test 1: fetchManifest(${TIMEOUT_MS}ms) rejects with RouteDockManifestTimeoutError (elapsed: ${elapsed}ms)`)
  } finally {
    await server.close()
  }
}

// ── Test 2: RouteDockManifestTimeoutError has correct properties ──────────────

{
  const cause = new DOMException('The operation timed out.', 'TimeoutError')
  const err = new RouteDockManifestTimeoutError(
    'Manifest fetch timed out after 5000ms from http://example.com/.well-known/routedock.json',
    { cause },
  )

  assert.strictEqual(err.code, 'MANIFEST_TIMEOUT', 'code must be MANIFEST_TIMEOUT')
  assert.strictEqual(err.retryable, true, 'timeout errors must be retryable')
  assert.ok(err.message.includes('5000ms'), 'message must include timeout value')
  assert.ok(err instanceof Error, 'must be an Error instance')
  assert.strictEqual(err.name, 'RouteDockManifestTimeoutError')
  assert.strictEqual(err.cause, cause, 'cause must be preserved')
  console.log('✓ Test 2: RouteDockManifestTimeoutError has correct code, retryable, message, and cause')
}

// ── Test 3: RouteDockClient.estimateCost propagates manifestTimeoutMs ─────────

{
  const server = await startHangingServer()
  try {
    const client = new RouteDockClient({
      wallet: Keypair.random().secret(),
      network: 'testnet',
      manifestTimeoutMs: 150,
      retryPolicy: { maxAttempts: 1 },
    })

    let caught: unknown
    try {
      await client.estimateCost(server.url)
    } catch (err) {
      caught = err
    }

    assert.ok(
      caught instanceof RouteDockManifestTimeoutError,
      `client.estimateCost must reject with RouteDockManifestTimeoutError, got ${String(caught)}`,
    )
    assert.ok(caught.message.includes('150ms'), `message must include 150ms, got "${caught.message}"`)
    assert.strictEqual(caught.code, 'MANIFEST_TIMEOUT')
    assert.strictEqual(caught.retryable, true)
    console.log('✓ Test 3: RouteDockClient.estimateCost propagates manifestTimeoutMs and rejects with RouteDockManifestTimeoutError')
  } finally {
    await server.close()
  }
}

console.log('\nAll manifest timeout tests passed.')
