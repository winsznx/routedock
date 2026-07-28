import { RouteDockError } from '../errors.js'

export interface RetryPolicy {
  /** Total attempts including the first call. Default: 4 (3 retries). */
  maxAttempts?: number
  /** Base delay for exponential backoff in ms. Default: 250. */
  baseDelayMs?: number
}

export const DEFAULT_RETRY_POLICY: Required<RetryPolicy> = {
  maxAttempts: 4,
  baseDelayMs: 250,
}

/** Delays between attempts: 250ms, 500ms, 1s, 2s, 4s (index = attempt - 1). */
export function backoffDelayMs(attempt: number, baseDelayMs: number): number {
  return baseDelayMs * 2 ** attempt
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Execute `fn` with exponential backoff on retryable RouteDockErrors.
 * Honors `retryAfterMs` from facilitator 429/503 responses when present.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy = {},
): Promise<T> {
  const { maxAttempts, baseDelayMs } = { ...DEFAULT_RETRY_POLICY, ...policy }
  let lastError: RouteDockError | undefined

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (!(err instanceof RouteDockError)) {
        throw err
      }
      lastError = err

      if (!err.retryable || attempt >= maxAttempts - 1) {
        throw err
      }

      const delay =
        err.retryAfterMs !== undefined
          ? err.retryAfterMs
          : backoffDelayMs(attempt, baseDelayMs)

      await sleep(delay)
    }
  }

  throw lastError ?? new RouteDockError('Retry exhausted', 'NETWORK', false)
}
