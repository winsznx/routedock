import { describe, expect, it } from 'vitest'
import { buildVoucherSnapshot } from '../voucherChart'

const options = { locale: 'en-US', timeZone: 'America/New_York' }
const row = (opened_at: string, voucher_count: number) => ({ opened_at, voucher_count })

describe('voucher session snapshots', () => {
  it('distinguishes the same minute on different local days', () => {
    const result = buildVoucherSnapshot([
      row('2026-10-21T14:05:00Z', 5), row('2026-10-20T14:05:00Z', 3),
    ], options)
    expect(result.points.map((p) => p.vouchers)).toEqual([3, 8])
    expect(result.points[0]?.label).toContain('Oct 20')
    expect(result.points[1]?.label).toContain('Oct 21')
    expect(result.points[0]?.fullTimestamp).toContain('10:05:00 AM')
    expect(result.points[0]?.fullTimestamp).toContain('GMT-04:00')
    expect(result.summary).toContain('8 vouchers across 2 sessions')
  })

  it('groups one day by minute and describes snapshots, not arrivals', () => {
    const result = buildVoucherSnapshot([
      row('2026-10-20T14:05:58Z', 4), row('2026-10-20T14:05:01Z', 2), row('2026-10-20T14:06:00Z', 1),
    ], options)
    expect(result.points.map((p) => p.vouchers)).toEqual([6, 7])
    expect(result.points[0]?.label).toBe('10:05 AM GMT-4')
    expect(result.summary).toContain('not voucher arrival times')
  })

  it('uses hourly buckets for ranges longer than a day', () => {
    const result = buildVoucherSnapshot([
      row('2026-10-20T14:05:00Z', 3), row('2026-10-20T14:59:00Z', 2), row('2026-10-22T14:05:00Z', 1),
    ], options)
    expect(result.points.map((p) => p.vouchers)).toEqual([5, 6])
    expect(result.points[0]?.timestamp).toBe(Date.parse('2026-10-20T14:00:00Z'))
  })

  it('uses local calendar boundaries even within one UTC day', () => {
    const result = buildVoucherSnapshot([
      row('2026-10-20T03:59:00Z', 1), row('2026-10-20T04:01:00Z', 2),
    ], options)
    expect(result.points[0]?.label).toContain('Oct 19')
    expect(result.points[1]?.label).toContain('Oct 20')
  })

  it('disambiguates repeated clock times at the daylight-saving transition', () => {
    const result = buildVoucherSnapshot([
      row('2026-11-01T05:30:00Z', 1), row('2026-11-01T06:30:00Z', 2),
    ], options)
    expect(new Set(result.points.map((p) => p.label)).size).toBe(2)
    expect(result.points[0]?.label).toContain('GMT-4')
    expect(result.points[1]?.label).toContain('GMT-5')
  })

  it('returns an empty snapshot for no sessions', () => {
    expect(buildVoucherSnapshot([], options)).toEqual({ points: [], summary: 'No session data yet' })
  })

  it('skips malformed rows without crashing the chart', () => {
    const result = buildVoucherSnapshot([row('bad date', 3), row('2026-10-20T14:05:00Z', -1)], options)
    expect(result.points).toEqual([])
  })
})
