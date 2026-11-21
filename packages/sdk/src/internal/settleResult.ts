import { extractPayerAddress } from '../provider/payer.js'

/**
 * Outcome of an x402 settle call. The facilitator reports failures as data
 * (`{ success: false, errorReason }`) rather than throwing, so every adapter
 * must read the same two pieces: the transaction hash when it really settled,
 * or the reason it did not.
 *
 * The client reads the same shape out of the provider's `X-Payment-Response`
 * header, so a settle the provider did not complete cannot be reported to the
 * agent as a transaction hash (#553).
 */
export type SettleOutcome = { ok: true; txHash: string } | { ok: false; reason?: string }

/**
 * Only an explicit `success: true` carrying a non-empty transaction hash counts
 * as settled. Anything else — including `success: true` with an empty
 * transaction — must not be recorded, reported through `onSettled`, or allowed
 * to reach the protected route.
 */
export function readSettleResult(result: unknown): SettleOutcome {
  const settle = result as
    | { success?: unknown; transaction?: unknown; errorReason?: string }
    | null
    | undefined
  const failed = (reason?: string): SettleOutcome => (reason ? { ok: false, reason } : { ok: false })
  if (!settle || settle.success !== true) return failed(settle?.errorReason)
  if (typeof settle.transaction !== 'string' || settle.transaction.length === 0) {
    return failed(settle.errorReason)
  }
  return { ok: true, txHash: settle.transaction }
}

/**
 * The payer the facilitator reports on a settle or verify result, validated.
 * The x402 Stellar payload carries a signed transaction, not a credentials
 * list, so the facilitator is the only place the payer's address comes from.
 * Anything missing or invalid yields null and never affects settlement.
 */
export function readSettlePayer(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null
  return extractPayerAddress((result as { payer?: unknown }).payer)
}
