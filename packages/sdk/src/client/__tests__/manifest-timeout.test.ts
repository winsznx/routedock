/**
 * Tests for the manifest-timeout mechanism.
 *
 * Tests the building blocks of the timeout implementation:
 *   1. AbortSignal.timeout() causes fetch to reject with TimeoutError/AbortError
 *   2. RouteDockManifestTimeoutError has the correct code, retryable flag, and cause
 *   3. The error-detection pattern (err.name check) correctly identifies timeout errors
 *
 * The full integration (fetchManifest → RouteDockManifestTimeoutError on hang) is
 * tested via `pnpm test` which resolves ajv through the pnpm virtual store.
 *
 * Run with: pnpm --filter @routedock/sdk test
 */

import * as http from 'node:http'
import assert from 'node:assert/strict'
import { RouteDockManifestTimeoutError } from '../../errors.js'

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

/** The exact error-detection pattern used in ModeRouter.fetchManifest */
function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')
}

// ── Test 1: AbortSignal.timeout() causes fetch to reject on a hanging server ──

{
  const server = await startHangingServer()
  try {
    const TIMEOUT_MS = 200
    const start = Date.now()
    let rawErr: unknown
    try {
      await fetch(server.url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (err) {
      rawErr = err
    }

    const elapsed = Date.now() - start
    assert.ok(rawErr instanceof Error, 'fetch must throw on hanging server with timeout')
    assert.ok(
      isTimeoutError(rawErr),
      `raw error must be TimeoutError or AbortError, got name="${(rawErr as Error).name}"`,
    )
    assert.ok(elapsed < 2000, `Should abort quickly, took ${elapsed}ms`)
    console.log(`✓ Test 1: AbortSignal.timeout(${TIMEOUT_MS}ms) fires on hanging server (elapsed: ${elapsed}ms)`)
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

// ── Test 3: isTimeoutError correctly classifies timeout errors ────────────────

{
  const timeoutDom = new DOMException('timed out', 'TimeoutError')
  const abortDom = new DOMException('aborted', 'AbortError')
  const genericErr = new Error('some other error')
  const networkErr = Object.assign(new Error('ECONNREFUSED'), { name: 'FetchError' })

  assert.ok(isTimeoutError(timeoutDom), 'TimeoutError DOMException should be detected')
  assert.ok(isTimeoutError(abortDom), 'AbortError DOMException should be detected')
  assert.ok(!isTimeoutError(genericErr), 'generic Error should NOT be detected as timeout')
  assert.ok(!isTimeoutError(networkErr), 'FetchError should NOT be detected as timeout')
  assert.ok(!isTimeoutError(null), 'null should NOT be detected as timeout')
  assert.ok(!isTimeoutError('string'), 'string should NOT be detected as timeout')
  console.log('✓ Test 3: isTimeoutError() correctly classifies timeout vs non-timeout errors')
}

// ── Test 4: end-to-end — fetch → detect → wrap as RouteDockManifestTimeoutError

{
  const server = await startHangingServer()
  try {
    const TIMEOUT_MS = 150
    const url = `${server.url}/.well-known/routedock.json`
    let wrapped: RouteDockManifestTimeoutError | undefined

    try {
      await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (err) {
      if (isTimeoutError(err)) {
        wrapped = new RouteDockManifestTimeoutError(
          `Manifest fetch timed out after ${TIMEOUT_MS}ms from ${url}`,
          { cause: err },
        )
      }
    }

    assert.ok(wrapped instanceof RouteDockManifestTimeoutError, 'should wrap as RouteDockManifestTimeoutError')
    assert.strictEqual(wrapped.code, 'MANIFEST_TIMEOUT')
    assert.ok(wrapped.retryable)
    assert.ok(wrapped.cause instanceof Error)
    console.log('✓ Test 4: fetch → timeout detection → RouteDockManifestTimeoutError wrapping works end-to-end')
  } finally {
    await server.close()
  }
}

console.log('\nAll manifest timeout tests passed.')
