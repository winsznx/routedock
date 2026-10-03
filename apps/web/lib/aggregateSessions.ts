import { usdcToStroops, USDC_DECIMALS } from '@routedock/nulth-sdk'
import type { Session } from './supabase'

export interface DashboardAggregates {
  activeSessions: Session[]
  totalVouchers: number
  totalSettled: number
  lastSettlement: Session | undefined
}

/**
 * Pure aggregation over a sessions array. Extracted from the page component so
 * it can be unit-tested without a Next.js or Supabase dependency.
 *
 * Assumptions this function encodes (and tests should pin):
 * - `status === 'open'`  means the channel is live
 * - `voucher_count` may be null/undefined — treated as 0
 * - `cumulative_amount` is a decimal USDC *string* (see `SESSION_COLUMNS`), not a
 *   number and not stroops. A row whose amount cannot be parsed is logged and
 *   skipped, so one bad row cannot take the whole dashboard down.
 * - `lastSettlement` is the first closed session with a settlement_tx_hash in
 *   the array; the caller is responsible for ordering (newest-first by opened_at)
 */
export function aggregateSessions(sessions: Session[]): DashboardAggregates {
  const activeSessions = sessions.filter((s) => s.status === 'open')

  const totalVouchers = sessions.reduce((sum, s) => sum + (s.voucher_count ?? 0), 0)

  const totalSettledStroops = sessions
    .filter((s) => s.status === 'closed')
    .reduce((sum, s) => {
      const raw = s.cumulative_amount ?? '0'
      try {
        return sum + usdcToStroops(raw)
      } catch {
        console.error(
          `[aggregateSessions] skipping session ${s.id}: unparseable cumulative_amount ${JSON.stringify(raw)}`,
        )
        return sum
      }
    }, BigInt(0))

  const totalSettled = Number(totalSettledStroops) / 10 ** USDC_DECIMALS

  const lastSettlement = sessions
    .filter((s) => s.status === 'closed' && s.settlement_tx_hash)
    .at(0)

  return { activeSessions, totalVouchers, totalSettled, lastSettlement }
}
