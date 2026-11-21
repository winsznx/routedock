import type { PaymentResult } from './types.js'

/** Stable error codes for programmatic handling. */
export type RouteDockErrorCode =
  | 'MANIFEST'
  | 'MANIFEST_TIMEOUT'
  | 'MANIFEST_SUNSET'
  | 'NO_SUPPORTED_MODE'
  | 'FACILITATOR'
  | 'NETWORK'
  | 'SIGNATURE'
  | 'VOUCHER_MONOTONICITY'
  | 'POLICY_REJECT'
  | 'PAYMENT_REJECTED'
  | 'PAID_RESPONSE'
  | 'CHANNEL_STATE'
  | 'DISPUTE'
  | 'REFUND_WINDOW'
  | 'CLIENT_VERSION_TOO_OLD'
  | 'TRUSTLINE'

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

/** Manifest fetch exceeded the configured timeout without receiving a response. */
export class RouteDockManifestTimeoutError extends RouteDockError {
  constructor(message: string, options: RouteDockErrorOptions = {}) {
    super(message, 'MANIFEST_TIMEOUT', true, options)
    this.name = 'RouteDockManifestTimeoutError'
  }
}

/** The provider's signed manifest has reached its declared sunset timestamp. */
export class RouteDockManifestSunsetError extends RouteDockError {
  constructor(message: string, options: RouteDockErrorOptions = {}) {
    super(message, 'MANIFEST_SUNSET', false, options)
    this.name = 'RouteDockManifestSunsetError'
  }
}

/** No payment mode in the manifest is supported by this client. */
export class RouteDockNoSupportedModeError extends RouteDockError {
  constructor(message: string, options: RouteDockErrorOptions = {}) {
    super(message, 'NO_SUPPORTED_MODE', false, options)
    this.name = 'RouteDockNoSupportedModeError'
  }
}

/** This client's SDK version is below the manifest's min_client_version. Upgrade the SDK to proceed. */
export class RouteDockClientVersionError extends RouteDockError {
  constructor(message: string, options: RouteDockErrorOptions = {}) {
    super(message, 'CLIENT_VERSION_TOO_OLD', false, options)
    this.name = 'RouteDockClientVersionError'
  }
}

/**
 * Account is missing a trustline for the payment asset.
 * Thrown preflight — before any payment transaction is submitted —
 * so the caller can establish the trustline first.
 */
export class RouteDockTrustlineError extends RouteDockError {
  readonly asset: string
  readonly issuer: string
  readonly remediation: string

  constructor(
    asset: string,
    issuer: string,
    remediation: string,
    options: RouteDockErrorOptions = {},
  ) {
    super(
      `Missing trustline for ${asset} (issuer: ${issuer}). ${remediation}`,
      'TRUSTLINE',
      false,
      options,
    )
    this.name = 'RouteDockTrustlineError'
    this.asset = asset
    this.issuer = issuer
    this.remediation = remediation
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

/**
 * The provider refused a signed, paid request (HTTP 4xx such as 401/402).
 * Not a manifest problem and not a local policy rejection: `status` is the HTTP
 * status and `reason` is the provider's own explanation when it sent one
 * (e.g. the facilitator's `invalidReason`). Not retryable — the same signed
 * payment would be refused again.
 */
export class RouteDockPaymentRejectedError extends RouteDockError {
  readonly status: number
  /** The provider's `reason` field, if its response body was JSON and had one. */
  readonly reason?: string
  /** The provider's `error` field (short summary), if present. */
  readonly providerError?: string

  constructor(
    message: string,
    status: number,
    details: { reason?: string; providerError?: string } = {},
    options: RouteDockErrorOptions = {},
  ) {
    super(message, 'PAYMENT_REJECTED', false, options)
    this.name = 'RouteDockPaymentRejectedError'
    this.status = status
    if (details.reason !== undefined) this.reason = details.reason
    if (details.providerError !== undefined) this.providerError = details.providerError
  }
}

/**
 * A paid request succeeded, but its response body could not be read.
 * Payment must remain counted against spend caps and must not be retried.
 */
export class RouteDockPaidResponseError extends RouteDockError {
  readonly paid = true
  readonly txHash: string | null
  readonly amount: string
  readonly mode: PaymentResult['mode']
  readonly contentType?: string

  constructor(
    message: string,
    payment: Pick<PaymentResult, 'txHash' | 'amount' | 'mode' | 'contentType'>,
    options: RouteDockErrorOptions = {},
  ) {
    super(message, 'PAID_RESPONSE', false, options)
    this.name = 'RouteDockPaidResponseError'
    this.txHash = payment.txHash
    this.amount = payment.amount
    this.mode = payment.mode
    if (payment.contentType !== undefined) this.contentType = payment.contentType
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

const MAX_REJECTION_BODY_BYTES = 64 * 1024
const MAX_REJECTION_FIELD_CHARS = 500

/** Read at most `limit` bytes of a body as text; `null` if it is larger or unreadable. */
async function readBoundedText(response: Response, limit: number): Promise<string | null> {
  const body = response.body
  if (!body) return null
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) {
        await reader.cancel().catch(() => undefined)
        return null
      }
      chunks.push(value)
    }
  } catch {
    return null
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

/**
 * Build a {@link RouteDockPaymentRejectedError} from a rejected paid response.
 * Reads the JSON body best-effort (a missing, non-JSON or oversized body just
 * means no `reason`; the provider is untrusted, so the read is bounded and the
 * fields are length-capped), and never throws.
 */
export async function paymentRejectedError(
  label: string,
  status: number,
  response: Response,
): Promise<RouteDockPaymentRejectedError> {
  let reason: string | undefined
  let providerError: string | undefined
  try {
    const text = await readBoundedText(response, MAX_REJECTION_BODY_BYTES)
    const body: unknown = text === null ? null : JSON.parse(text)
    if (body !== null && typeof body === 'object') {
      const { reason: r, error: e } = body as { reason?: unknown; error?: unknown }
      if (typeof r === 'string' && r.length > 0) reason = r.slice(0, MAX_REJECTION_FIELD_CHARS)
      if (typeof e === 'string' && e.length > 0) providerError = e.slice(0, MAX_REJECTION_FIELD_CHARS)
    }
  } catch {
    // best effort only — keep the status-only message
  }
  const detail = reason ?? providerError
  return new RouteDockPaymentRejectedError(
    `${label}: HTTP ${status}${detail ? ` — ${detail}` : ''}`,
    status,
    {
      ...(reason !== undefined ? { reason } : {}),
      ...(providerError !== undefined ? { providerError } : {}),
    },
  )
}

/** Wrap a low-level fetch failure; preserves existing RouteDockErrors. */
export function wrapFetchError(err: unknown, context: string): RouteDockError {
  if (err instanceof RouteDockError) return err
  return new RouteDockNetworkError(`${context}: ${String(err)}`, { cause: err })
}

/**
 * Wrap an mppx failure; differentiates network transport errors from signing/credential errors.
 * Real transport failures (fetch TypeError, AbortError, TimeoutError) are wrapped as retryable
 * RouteDockNetworkError, while signing and challenge failures are wrapped as non-retryable
 * RouteDockSignatureError.
 */
export function wrapMppError(err: unknown, context: string): RouteDockError {
  if (err instanceof RouteDockError) return err
  if (
    err instanceof TypeError ||
    (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError'))
  ) {
    return new RouteDockNetworkError(`${context}: ${String(err)}`, { cause: err })
  }
  return new RouteDockSignatureError(`${context}: ${String(err)}`, { cause: err })
}
