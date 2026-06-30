import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  RouteDockError,
  RouteDockManifestError,
  RouteDockFacilitatorError,
  RouteDockNetworkError,
  parseRetryAfterMs,
} from '../errors.js'
import { withRetry, backoffDelayMs, DEFAULT_RETRY_POLICY } from '../internal/retry.js'

describe('backoffDelayMs', () => {
  it('doubles from baseDelayMs per attempt', () => {
    assert.equal(backoffDelayMs(0, 250), 250)
    assert.equal(backoffDelayMs(1, 250), 500)
    assert.equal(backoffDelayMs(2, 250), 1000)
    assert.equal(backoffDelayMs(3, 250), 2000)
    assert.equal(backoffDelayMs(4, 250), 4000)
  })
})

describe('withRetry', () => {
  it('retries retryable errors up to maxAttempts', async () => {
    let calls = 0
    const result = await withRetry(
      async () => {
        calls++
        if (calls < 3) {
          throw new RouteDockNetworkError('transient')
        }
        return 'ok'
      },
      { maxAttempts: 4, baseDelayMs: 1 },
    )
    assert.equal(result, 'ok')
    assert.equal(calls, 3)
  })

  it('does not retry non-retryable errors', async () => {
    let calls = 0
    await assert.rejects(
      () =>
        withRetry(
          () => {
            calls++
            throw new RouteDockManifestError('invalid manifest')
          },
          { maxAttempts: 4, baseDelayMs: 1 },
        ),
      (err: unknown) => err instanceof RouteDockManifestError,
    )
    assert.equal(calls, 1)
  })

  it('honors retryAfterMs from facilitator errors', async () => {
    const delays: number[] = []
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0)
      return originalSetTimeout(fn, 0)
    }) as typeof setTimeout

    let calls = 0
    try {
      await assert.rejects(
        () =>
          withRetry(
            () => {
              calls++
              throw new RouteDockFacilitatorError('rate limited', 429, {
                retryAfterMs: 750,
              })
            },
            { maxAttempts: 3, baseDelayMs: 250 },
          ),
        (err: unknown) => err instanceof RouteDockFacilitatorError,
      )
      assert.equal(calls, 3)
      assert.ok(delays.length >= 2, 'expected at least 2 retry delays')
      assert.ok(
        delays.every((d) => d === 750),
        `expected Retry-After delay 750ms, got ${delays.join(',')}`,
      )
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
  })

  it('stops at maxAttempts for persistent retryable errors', async () => {
    let calls = 0
    await assert.rejects(
      () =>
        withRetry(
          () => {
            calls++
            throw new RouteDockNetworkError('still down')
          },
          { maxAttempts: 4, baseDelayMs: 1 },
        ),
      (err: unknown) => err instanceof RouteDockNetworkError,
    )
    assert.equal(calls, DEFAULT_RETRY_POLICY.maxAttempts)
  })

  it('rethrows non-RouteDock errors immediately', async () => {
    let calls = 0
    await assert.rejects(
      () =>
        withRetry(
          () => {
            calls++
            throw new TypeError('unexpected')
          },
          { maxAttempts: 4, baseDelayMs: 1 },
        ),
      (err: unknown) => err instanceof TypeError,
    )
    assert.equal(calls, 1)
  })
})

describe('parseRetryAfterMs', () => {
  it('parses Retry-After seconds', () => {
    const res = new Response(null, { headers: { 'Retry-After': '2' } })
    assert.equal(parseRetryAfterMs(res), 2000)
  })
})
