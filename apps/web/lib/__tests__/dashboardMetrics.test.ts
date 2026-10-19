import { describe, it, expect } from 'vitest'
import { toDashboardMetrics, type DashboardStatsRow } from '../dashboardMetrics'

const NULL_ROW: DashboardStatsRow = {
  active_sessions: null,
  open_vouchers: null,
  total_settled: null,
  last_settlement_tx_hash: null,
  last_settlement_at: null,
}

describe('toDashboardMetrics', () => {
  it('maps a normal public_dashboard_stats row', () => {
    const metrics = toDashboardMetrics({
      active_sessions: 55,
      open_vouchers: 55,
      total_settled: '2.5000001',
      last_settlement_tx_hash: 'hash_A',
      last_settlement_at: '2026-09-25T12:00:00.000Z',
    })

    expect(metrics.activeSessions).toBe(55)
    expect(metrics.totalVouchers).toBe(55)
    expect(metrics.totalSettled).toBe(2.5000001)
    expect(metrics.lastSettlement).toEqual({
      settlement_tx_hash: 'hash_A',
      updated_at: '2026-09-25T12:00:00.000Z',
    })
  })

  it('maps a missing row to zeros and no last settlement', () => {
    const metrics = toDashboardMetrics(undefined)

    expect(metrics.activeSessions).toBe(0)
    expect(metrics.totalVouchers).toBe(0)
    expect(metrics.totalSettled).toBe(0)
    expect(metrics.lastSettlement).toBeUndefined()
  })

  it('maps null fields to zeros and no last settlement', () => {
    const metrics = toDashboardMetrics(NULL_ROW)

    expect(metrics.activeSessions).toBe(0)
    expect(metrics.totalVouchers).toBe(0)
    expect(metrics.totalSettled).toBe(0)
    expect(metrics.lastSettlement).toBeUndefined()
  })

  it('keeps 7-decimal total_settled exact through usdcToStroops', () => {
    expect(toDashboardMetrics({ ...NULL_ROW, total_settled: '2.5000001' }).totalSettled).toBe(
      2.5000001,
    )
    expect(toDashboardMetrics({ ...NULL_ROW, total_settled: '0.0000001' }).totalSettled).toBe(
      0.0000001,
    )
    expect(toDashboardMetrics({ ...NULL_ROW, total_settled: '0' }).totalSettled).toBe(0)
  })

  it('omits the last settlement when only one of hash/timestamp is present', () => {
    expect(
      toDashboardMetrics({ ...NULL_ROW, last_settlement_tx_hash: 'hash_A' }).lastSettlement,
    ).toBeUndefined()
    expect(
      toDashboardMetrics({
        ...NULL_ROW,
        last_settlement_at: '2026-09-25T12:00:00.000Z',
      }).lastSettlement,
    ).toBeUndefined()
  })
})
