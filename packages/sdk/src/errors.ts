/** Stable error codes for programmatic handling. */
export type RouteDockErrorCode =
  | 'MANIFEST'
  | 'NO_SUPPORTED_MODE'
  | 'FACILITATOR'
  | 'NETWORK'
  | 'SIGNATURE'
  | 'VOUCHER_MONOTONICITY'
  | 'POLICY_REJECT'
  | 'CHANNEL_STATE'
  | 'DISPUTE'
  | 'REFUND_WINDOW'

export interface RouteDockErrorOptions {
  cause?: unknown
  /** Milliseconds to wait before retry (e.g. from Retry-After header). */
  retryAfterMs?: number
}

/** Base error for all RouteDock SDK failures. */
export class RouteDockError extends Error {
  readonly code: RouteDockErrorCode
  readonly retryable: boolean
  readonly retryAfterMs?: number

  constructor(
    message: string,
    code: RouteDockErrorCode,
    retryable: boolean,
    options: RouteDockErrorOptions = {},
  ) {
    super(message, { cause: options.cause })
    this.name = 'RouteDockError'
    this.code = code
    this.retryable = retryable
    if (options.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs
    }
  }
}

/** Manifest fetch failed, schema invalid, or required fields missing. */
export class RouteDockManifestError extends RouteDockError {
  constructor(message: string, options: RouteDockErrorOptions = {}) {
    super(message, 'MANIFEST', false, options)
    this.name = 'RouteDockManifestError'
  }
}

/** No payment mode in the manifest is supported by this client. */
export class RouteDockNoSupportedModeError extends RouteDockError {
  constructor(message: string, options: RouteDockErrorOptions = {}) {
    super(message, 'NO_SUPPORTED_MODE', false, options)
    this.name = 'RouteDockNoSupportedModeError'
  }
}

/** x402 facilitator or provider returned a retryable HTTP failure (5xx, 429). */
export class RouteDockFacilitatorError extends RouteDockError {
  readonly status: number

  constructor(
    message: string,
    status: number,
    options: RouteDockErrorOptions = {},
  ) {
    super(message, 'FACILITATOR', true, options)
    this.name = 'RouteDockFacilitatorError'
    this.status = status
  }
}

/** Transient network failure (timeouts, connection reset, unreachable host). */
export class RouteDockNetworkError extends RouteDockError {
  constructor(message: string, options: RouteDockErrorOptions = {}) {
    super(message, 'NETWORK', true, options)
    this.name = 'RouteDockNetworkError'
  }
}

/** Payment or commitment signature could not be produced or verified. */
export class RouteDockSignatureError extends RouteDockError {
  constructor(message: string, options: RouteDockErrorOptions = {}) {
    super(message, 'SIGNATURE', false, options)
    this.name = 'RouteDockSignatureError'
  }
}

/** Voucher cumulative amount did not increase monotonically. */
export class RouteDockVoucherMonotonicityError extends RouteDockError {
  constructor(message: string, options: RouteDockErrorOptions = {}) {
    super(message, 'VOUCHER_MONOTONICITY', false, options)
    this.name = 'RouteDockVoucherMonotonicityError'
  }
}

/** Local spend cap or on-chain policy rejected the payment. */
export class RouteDockPolicyRejectError extends RouteDockError {
  readonly reason: string

  constructor(reason: string, options: RouteDockErrorOptions = {}) {
    super(`Payment rejected by policy: ${reason}`, 'POLICY_REJECT', false, options)
    this.name = 'RouteDockPolicyRejectError'
    this.reason = reason
  }
}

/** Channel lifecycle failure (open, simulate, close, missing settlement fields). */
export class RouteDockChannelStateError extends RouteDockError {
  constructor(message: string, options: RouteDockErrorOptions = {}) {
    super(message, 'CHANNEL_STATE', false, options)
    this.name = 'RouteDockChannelStateError'
  }
}

/** Channel dispute operation failed (refund request, settlement, or contract invariant). */
export class RouteDockDisputeError extends RouteDockError {
  constructor(message: string, options: RouteDockErrorOptions = {}) {
    super(message, 'DISPUTE', false, options)
    this.name = 'RouteDockDisputeError'
  }
}

/** Refund window has not yet opened or has already expired. */
export class RouteDockRefundWindowError extends RouteDockError {
  constructor(message: string, options: RouteDockErrorOptions = {}) {
    super(message, 'REFUND_WINDOW', false, options)
    this.name = 'RouteDockRefundWindowError'
  }
}

/** @deprecated Use {@link RouteDockPolicyRejectError} */
export const RouteDockPolicyRejectedError = RouteDockPolicyRejectError

/** @deprecated Use {@link RouteDockVoucherMonotonicityError} or {@link RouteDockChannelStateError} */
export const RouteDockSessionError = RouteDockVoucherMonotonicityError

/** Parse Retry-After from a Response (seconds or HTTP-date). */
export function parseRetryAfterMs(response: Response): number | undefined {
  const header = response.headers.get('Retry-After')
  if (!header) return undefined

  const seconds = Number(header)
  if (!Number.isNaN(seconds) && seconds >= 0) {
    return seconds * 1000
  }

  const date = Date.parse(header)
  if (!Number.isNaN(date)) {
    return Math.max(0, date - Date.now())
  }

  return undefined
}

/** Map an HTTP status to a typed, retryable-aware RouteDock error. */
export function httpStatusToError(
  message: string,
  status: number,
  response?: Response,
): RouteDockError {
  const retryAfterMs = response ? parseRetryAfterMs(response) : undefined
  const opts = retryAfterMs !== undefined ? { retryAfterMs } : {}

  if (status === 429 || status === 503 || (status >= 500 && status < 600)) {
    return new RouteDockFacilitatorError(message, status, opts)
  }

  if (status >= 400) {
    return new RouteDockManifestError(message, opts)
  }

  return new RouteDockNetworkError(message, opts)
}

/** Wrap a low-level fetch failure; preserves existing RouteDockErrors. */
export function wrapFetchError(err: unknown, context: string): RouteDockError {
  if (err instanceof RouteDockError) return err
  return new RouteDockNetworkError(`${context}: ${String(err)}`, { cause: err })
}
