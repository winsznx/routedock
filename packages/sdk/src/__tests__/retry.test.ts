import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  RouteDockError,
  RouteDockManifestError,
  RouteDockFacilitatorError,
  RouteDockNetworkError,
  httpStatusToError,
  parseRetryAfterMs,
} from '../errors.js'
import { withRetry, backoffDelayMs, DEFAULT_RETRY_POLICY } from '../internal/retry.js'

describe('backoffDelayMs', () => {
  it('applies full jitter within exponential backoff range', () => {
    const originalRandom = Math.random
    Math.random = () => 0.5

    try {
      assert.equal(backoffDelayMs(0, 250), 125)
      assert.equal(backoffDelayMs(1, 250), 250)
      assert.equal(backoffDelayMs(2, 250), 500)
      assert.equal(backoffDelayMs(3, 250), 1000)
      assert.equal(backoffDelayMs(4, 250), 2000)
    } finally {
      Math.random = originalRandom
    }
  })

  it('caps jittered backoff at maxDelayMs', () => {
    const originalRandom = Math.random
    Math.random = () => 0.5

    try {
      assert.equal(backoffDelayMs(10, 250, 1000), 500)
    } finally {
      Math.random = originalRandom
    }
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
        return Promise.resolve('ok')
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

  it('uses capped full jitter for retry delays when retryAfterMs is absent', async () => {
    const delays: number[] = []
    const originalSetTimeout = globalThis.setTimeout
    const originalRandom = Math.random
    Math.random = () => 0.25
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      delays.push(ms ?? 0)
      return originalSetTimeout(fn, 0)
    }) as typeof setTimeout

    let calls = 0
    try {
      const result = await withRetry(
        async () => {
          calls++
          if (calls < 3) {
            throw new RouteDockNetworkError('transient')
          }
          return Promise.resolve('ok')
        },
        { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 150 },
      )
      assert.equal(result, 'ok')
      assert.equal(calls, 3)
      assert.deepEqual(delays, [25, 37])
    } finally {
      globalThis.setTimeout = originalSetTimeout
      Math.random = originalRandom
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

  it('calls onRetry with attempt number, error, and delay before each retry', async () => {
    const retries: Array<{ attempt: number; error: Error; delay: number }> = []
    let calls = 0
    const result = await withRetry(
      async () => {
        calls++
        if (calls < 3) {
          throw new RouteDockNetworkError('transient')
        }
        return Promise.resolve('ok')
      },
      {
        maxAttempts: 4,
        baseDelayMs: 100,
        onRetry: (attempt, error, nextDelayMs) => {
          retries.push({ attempt, error, delay: nextDelayMs })
        },
      },
    )
    assert.equal(result, 'ok')
    assert.equal(retries.length, 2)
    const first = retries[0]!
    const second = retries[1]!
    assert.equal(first.attempt, 0)
    assert.ok(first.error instanceof RouteDockNetworkError)
    assert.ok(first.delay >= 0)
    assert.equal(second.attempt, 1)
  })

  it('does not call onRetry when the error is not retryable', async () => {
    const retries: number[] = []
    await assert.rejects(
      () =>
        withRetry(
          () => {
            throw new RouteDockManifestError('bad')
          },
          {
            maxAttempts: 4,
            baseDelayMs: 1,
            onRetry: (attempt) => {
              retries.push(attempt)
            },
          },
        ),
      (err: unknown) => err instanceof RouteDockManifestError,
    )
    assert.equal(retries.length, 0)
  })

  it('does not call onRetry on the final attempt', async () => {
    const retries: number[] = []
    await assert.rejects(
      () =>
        withRetry(
          () => {
            throw new RouteDockNetworkError('still down')
          },
          {
            maxAttempts: 3,
            baseDelayMs: 1,
            onRetry: (attempt) => {
              retries.push(attempt)
            },
          },
        ),
      (err: unknown) => err instanceof RouteDockNetworkError,
    )
    assert.deepEqual(retries, [0, 1])
  })

  it('isolates onRetry callback errors and retries with original error surfaced', async () => {
    let calls = 0
    const loggedErrors: unknown[] = []
    const originalConsoleError = console.error
    console.error = (...params: any[]) => {
      if (typeof params[0] === 'string' && params[0].includes('onRetry')) {
        loggedErrors.push(...params.slice(1))
      }
      originalConsoleError(...params)
    }

    try {
      await assert.rejects(
        () =>
          withRetry(
            () => {
              calls++
              throw new RouteDockNetworkError('transient')
            },
            {
              maxAttempts: 3,
              baseDelayMs: 1,
              onRetry: () => {
                throw new Error('logger exploded')
              },
            },
          ),
        (err: unknown) =>
          err instanceof RouteDockNetworkError &&
          err.message === 'transient',
      )
      assert.equal(calls, 3)
      assert.ok(
        loggedErrors.some((e) => e instanceof Error && e.message === 'logger exploded'),
      )
    } finally {
      console.error = originalConsoleError
    }
  })

  it('isolates async onRetry rejections and continues retrying', async () => {
    let calls = 0
    const loggedErrors: unknown[] = []
    const originalConsoleError = console.error
    console.error = (...params: any[]) => {
      if (typeof params[0] === 'string' && params[0].includes('onRetry')) {
        loggedErrors.push(...params.slice(1))
      }
      originalConsoleError(...params)
    }

    try {
      const result = await withRetry(
        async () => {
          calls++
          if (calls < 3) {
            throw new RouteDockNetworkError('transient')
          }
          return Promise.resolve('ok')
        },
        {
          maxAttempts: 4,
          baseDelayMs: 1,
          onRetry: async () => {
            throw new Error('logger exploded async')
          },
        },
      )
      assert.equal(result, 'ok')
      assert.equal(calls, 3)
      assert.ok(
        loggedErrors.some((e) => e instanceof Error && e.message === 'logger exploded async'),
      )
    } finally {
      console.error = originalConsoleError
    }
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

describe('withRetry — Retry-After is capped by maxDelayMs', () => {
  /** Run `fn` with setTimeout stubbed so retry sleeps are recorded, not waited. */
  async function recordDelays(fn: () => Promise<unknown>): Promise<{ delays: number[]; error: unknown }> {
    const delays: number[] = []
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((cb: () => void, ms?: number) => {
      delays.push(ms ?? 0)
      return originalSetTimeout(cb, 0)
    }) as typeof setTimeout
    let error: unknown
    try {
      await fn()
    } catch (err) {
      error = err
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }
    return { delays, error }
  }

  it('clamps a large retryAfterMs to a custom maxDelayMs and keeps the raw hint on the error', async () => {
    const { delays, error } = await recordDelays(() =>
      withRetry(
        () => {
          throw new RouteDockFacilitatorError('busy', 503, { retryAfterMs: 3_600_000 })
        },
        { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1_000 },
      ),
    )
    assert.deepEqual(delays, [1_000, 1_000])
    assert.ok(error instanceof RouteDockFacilitatorError)
    assert.equal(error.retryAfterMs, 3_600_000, 'raw server hint is left untouched')
  })

  it('clamps to the 30s default when no policy is given', async () => {
    const { delays, error } = await recordDelays(() =>
      withRetry(() => {
        throw new RouteDockFacilitatorError('busy', 503, { retryAfterMs: 3_600_000 })
      }),
    )
    assert.deepEqual(delays, [30_000, 30_000, 30_000])
    assert.ok(error instanceof RouteDockFacilitatorError)
  })

  it('clamps a Retry-After header carried through httpStatusToError (end to end)', async () => {
    const { delays, error } = await recordDelays(() =>
      withRetry(() => {
        throw httpStatusToError(
          'busy',
          503,
          new Response(null, { status: 503, headers: { 'Retry-After': '86400' } }),
        )
      }),
    )
    assert.deepEqual(delays, [30_000, 30_000, 30_000])
    assert.ok(error instanceof RouteDockFacilitatorError)
    assert.equal(error.retryAfterMs, 86_400_000)
  })

  it('still honors a Retry-After below maxDelayMs exactly', async () => {
    const { delays } = await recordDelays(() =>
      withRetry(
        () => {
          throw new RouteDockFacilitatorError('busy', 429, { retryAfterMs: 750 })
        },
        { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1_000 },
      ),
    )
    assert.deepEqual(delays, [750, 750])
  })

  it('does not clamp a Retry-After equal to maxDelayMs', async () => {
    const { delays } = await recordDelays(() =>
      withRetry(
        () => {
          throw new RouteDockFacilitatorError('busy', 429, { retryAfterMs: 1_000 })
        },
        { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1_000 },
      ),
    )
    assert.deepEqual(delays, [1_000])
  })

  it('passes the clamped delay to onRetry as nextDelayMs', async () => {
    const seen: number[] = []
    const { delays } = await recordDelays(() =>
      withRetry(
        () => {
          throw new RouteDockFacilitatorError('busy', 503, { retryAfterMs: 3_600_000 })
        },
        {
          maxAttempts: 3,
          baseDelayMs: 1,
          maxDelayMs: 1_000,
          onRetry: (_attempt, _err, nextDelayMs) => {
            seen.push(nextDelayMs)
          },
        },
      ),
    )
    assert.deepEqual(seen, [1_000, 1_000])
    assert.deepEqual(delays, [1_000, 1_000])
  })
})

describe('parseRetryAfterMs', () => {
  it('parses Retry-After seconds', () => {
    const res = new Response(null, { headers: { 'Retry-After': '2' } })
    assert.equal(parseRetryAfterMs(res), 2000)
  })
})
