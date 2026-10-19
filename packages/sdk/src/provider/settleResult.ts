/**
 * Outcome of an x402 settle call. The facilitator reports failures as data
 * (`{ success: false, errorReason }`) rather than throwing, so every adapter
 * must read the same two pieces: the transaction hash when it really settled,
 * or the reason it did not.
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
