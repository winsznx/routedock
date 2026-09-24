/**
 * Tests that a 200 response with a non-JSON body at the manifest path is a
 * deterministic misconfiguration (MANIFEST), not a retryable network error.
 * See issue #411.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchManifest } from '../ModeRouter.js'
import { RouteDockManifestError, RouteDockNetworkError } from '../../errors.js'

const originalFetch = globalThis.fetch

test('manifest - 200 non-JSON body rejects with non-retryable MANIFEST error and no retry', async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    return new Response('<html>not json</html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    })
  }) as typeof fetch

  const baseUrl = 'http://provider-invalid-json.test'
  try {
    await assert.rejects(
      () => fetchManifest(baseUrl),
      (err: unknown) => {
        assert.ok(err instanceof RouteDockManifestError, 'should be RouteDockManifestError')
        assert.equal(err.code, 'MANIFEST')
        assert.equal(err.retryable, false, 'deterministic manifest failures must not be retryable')
        assert.ok(err.message.includes(baseUrl), `message should contain the URL, got: ${err.message}`)
        assert.ok(
          err.cause instanceof SyntaxError,
          `cause should be the original SyntaxError, got: ${String(err.cause)}`,
        )
        return true
      },
    )
    assert.equal(calls, 1, 'fetch must be called exactly once for a non-JSON manifest body')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('manifest - fetch rejection still surfaces as retryable NETWORK error', async () => {
  globalThis.fetch = (async () => {
    throw new TypeError('fetch failed')
  }) as typeof fetch

  try {
    await assert.rejects(
      () => fetchManifest('http://provider-network-error.test'),
      (err: unknown) => {
        assert.ok(err instanceof RouteDockNetworkError, 'should be RouteDockNetworkError')
        assert.equal(err.code, 'NETWORK')
        assert.equal(err.retryable, true, 'transport-level failures stay retryable')
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

console.log('\nAll manifest invalid-JSON tests passed.')