import { RouteDockError } from '../errors.js'
import { resolveLogger, type RouteDockLogger } from './logger.js'

export interface RetryPolicy {
  /** Total attempts including the first call. Default: 4 (3 retries). */
  maxAttempts?: number
  /** Base delay for exponential backoff in ms. Default: 250. */
  baseDelayMs?: number
  /** Maximum jittered backoff delay in ms. Default: 30000. */
  maxDelayMs?: number
  /** Called before each retry with the attempt number, error, and upcoming delay. */
  /**
   * Observability hook fired before each retry. Awaited, so a returned promise
   * is honoured; throwing or rejecting is caught and logged rather than
   * aborting the retry loop.
   */
  onRetry?: (attempt: number, error: Error, nextDelayMs: number) => void | Promise<void>
  /**
   * Log sink for internal diagnostics (an `onRetry` hook that throws).
   * Defaults to a console-backed logger.
   */
  logger?: RouteDockLogger
}

export const DEFAULT_RETRY_POLICY: Required<Omit<RetryPolicy, 'onRetry' | 'logger'>> = {
  maxAttempts: 4,
  baseDelayMs: 250,
  maxDelayMs: 30_000,
}

/**
 * Full jitter exponential backoff delay.
 * Delay range: 0..min(maxDelayMs, baseDelayMs * 2 ** attempt).
 */
export function backoffDelayMs(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs = DEFAULT_RETRY_POLICY.maxDelayMs,
): number {
  const cappedDelay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt)
  return Math.floor(Math.random() * (cappedDelay + 1))
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
  const { maxAttempts, baseDelayMs, maxDelayMs, onRetry, logger } = {
    ...DEFAULT_RETRY_POLICY,
    ...policy,
  }
  const log = resolveLogger(logger)
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
          : backoffDelayMs(attempt, baseDelayMs, maxDelayMs)

      if (onRetry) {
        try {
          await onRetry(attempt, err, delay)
        } catch (cbErr) {
          log('error', '[withRetry] onRetry callback threw:', { error: cbErr })
        }
      }

      await sleep(delay)
    }
  }

  throw lastError ?? new RouteDockError('Retry exhausted', 'NETWORK', false)
}
