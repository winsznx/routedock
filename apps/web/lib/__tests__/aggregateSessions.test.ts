import { describe, it, expect, vi, afterEach } from 'vitest'
import { aggregateSessions } from '../aggregateSessions'
import type { Session } from '../supabase'

// Minimal session factory — only the fields aggregateSessions reads.
// `cumulative_amount` is a decimal USDC *string* (see SESSION_COLUMNS).
function session(overrides: Partial<Session> & { status: Session['status'] }): Session {
  return {
    id: crypto.randomUUID(),
    channel_id: 'chan_' + Math.random().toString(36).slice(2),
    payee: 'GPAYEE',
    payer: 'GPAYER',
    cumulative_amount: '0',
    network: 'testnet',
    opened_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    settlement_tx_hash: null,
    open_tx_hash: null,
    voucher_count: 0,
    ...overrides,
  }
}

describe('aggregateSessions', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns zero/empty aggregates for an empty session list', () => {
    const result = aggregateSessions([])
    expect(result.activeSessions).toEqual([])
    expect(result.totalVouchers).toBe(0)
    expect(result.totalSettled).toBe(0)
    expect(result.lastSettlement).toBeUndefined()
  })

  it('counts only open sessions as active', () => {
    const sessions = [
      session({ status: 'open' }),
      session({ status: 'open' }),
      session({ status: 'closed', cumulative_amount: '1' }),
      session({ status: 'closing' }),
    ]
    const { activeSessions } = aggregateSessions(sessions)
    expect(activeSessions).toHaveLength(2)
    expect(activeSessions.every((s) => s.status === 'open')).toBe(true)
  })

  it('sums voucher_count across all sessions regardless of status', () => {
    const sessions = [
      session({ status: 'open', voucher_count: 10 }),
      session({ status: 'open', voucher_count: 5 }),
      session({ status: 'closed', voucher_count: 35, cumulative_amount: '1' }),
    ]
    expect(aggregateSessions(sessions).totalVouchers).toBe(50)
  })

  it('treats null voucher_count as 0', () => {
    const sessions = [
      session({ status: 'open', voucher_count: null as unknown as number }),
      session({ status: 'open', voucher_count: 7 }),
    ]
    expect(aggregateSessions(sessions).totalVouchers).toBe(7)
  })

  it('returns 0 totalSettled when all sessions are open', () => {
    const sessions = [
      session({ status: 'open', voucher_count: 10 }),
      session({ status: 'open', voucher_count: 20 }),
    ]
    expect(aggregateSessions(sessions).totalSettled).toBe(0)
  })

  it('accumulates totalSettled only from closed sessions in USDC', () => {
    const sessions = [
      session({ status: 'closed', cumulative_amount: '0.05', voucher_count: 5 }),
      session({ status: 'closed', cumulative_amount: '0.1', voucher_count: 10 }),
      session({ status: 'open', cumulative_amount: '99', voucher_count: 1 }), // must be ignored
    ]
    const { totalSettled } = aggregateSessions(sessions)
    // 0.05 + 0.10 = 0.15 USDC
    expect(totalSettled).toBeCloseTo(0.15, 6)
  })

  it('treats null cumulative_amount as 0 for closed sessions', () => {
    const sessions = [
      session({ status: 'closed', cumulative_amount: null as unknown as string }),
      session({ status: 'closed', cumulative_amount: '0.1' }),
    ]
    const { totalSettled } = aggregateSessions(sessions)
    expect(totalSettled).toBeCloseTo(0.1, 6)
  })

  it('picks lastSettlement as the first closed session with a tx hash (ordering assumption)', () => {
    // Array is newest-first (as the query orders it). The first closed+settled
    // row in the array should be returned — this pins the assumption that
    // array order determines "last settlement".
    const newest = session({ status: 'closed', cumulative_amount: '1', settlement_tx_hash: 'hash_new' })
    const older = session({ status: 'closed', cumulative_amount: '0.5', settlement_tx_hash: 'hash_old' })
    const open = session({ status: 'open' })

    const { lastSettlement } = aggregateSessions([open, newest, older])
    expect(lastSettlement).toBe(newest)
    expect(lastSettlement?.settlement_tx_hash).toBe('hash_new')
  })

  it('returns undefined for lastSettlement when no closed session has a tx hash', () => {
    const sessions = [
      session({ status: 'closed', cumulative_amount: '1', settlement_tx_hash: null }),
      session({ status: 'open' }),
    ]
    expect(aggregateSessions(sessions).lastSettlement).toBeUndefined()
  })

  it('ignores closed sessions without a tx hash when finding lastSettlement', () => {
    const withHash = session({ status: 'closed', cumulative_amount: '1', settlement_tx_hash: 'abc123' })
    const withoutHash = session({ status: 'closed', cumulative_amount: '2', settlement_tx_hash: null })
    // withoutHash comes first in the array, but must be skipped
    const { lastSettlement } = aggregateSessions([withoutHash, withHash])
    expect(lastSettlement).toBe(withHash)
  })
})

// Regression coverage for the sub-micro-USDC 500 (#343). `sessions.cumulative_amount`
// is NUMERIC(20,7); PostgREST sends it as a JSON number, and String() renders any
// value below 1e-6 in exponent form ("5e-7"), which usdcToStroops rejects. Selecting
// the column as text keeps it in plain decimal notation.
describe('aggregateSessions sub-micro-USDC amounts', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('totals a single-stroop session without throwing', () => {
    // Reproduces the row shape a PostgREST body actually produces once the column
    // is selected as text.
    const row = JSON.parse('{"cumulative_amount":"0.0000005"}') as Pick<Session, 'cumulative_amount'>
    const sessions = [session({ status: 'closed', ...row })]

    const { totalSettled } = aggregateSessions(sessions)
    expect(totalSettled).toBe(0.0000005)
  })

  it('sums fixed 7dp decimal strings and ignores open rows', () => {
    const sessions = [
      session({ status: 'closed', cumulative_amount: '0.0000005' }),
      session({ status: 'closed', cumulative_amount: '0.0001000' }),
      session({ status: 'closed', cumulative_amount: '1.0000000' }),
      session({ status: 'open', cumulative_amount: '99.0000000' }), // must be ignored
    ]
    // 0.0000005 + 0.0001 + 1 = 1.0001005
    expect(aggregateSessions(sessions).totalSettled).toBe(1.0001005)
  })

  it('skips a malformed amount, keeps summing the rest, and logs the bad row', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bad = session({ status: 'closed', cumulative_amount: 'abc' })
    const sessions = [
      bad,
      session({ status: 'closed', cumulative_amount: '0.25' }),
      session({ status: 'closed', cumulative_amount: '0.75' }),
    ]

    const { totalSettled } = aggregateSessions(sessions)

    expect(totalSettled).toBe(1)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(String(errorSpy.mock.calls[0]?.[0])).toContain(bad.id)
  })
})
