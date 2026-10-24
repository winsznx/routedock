export interface VoucherSessionRow {
  opened_at: string
  voucher_count: number | null
}

export interface VoucherChartPoint {
  timestamp: number
  label: string
  fullTimestamp: string
  vouchers: number
}

/** Current voucher totals grouped by session opening time, not voucher arrival. */
export function buildVoucherSnapshot(
  rows: readonly VoucherSessionRow[],
  options: { locale?: string; timeZone?: string } = {},
) {
  const sessions = rows
    .map((row) => ({ timestamp: Date.parse(row.opened_at), count: row.voucher_count ?? 0 }))
    .filter(({ timestamp, count }) => Number.isFinite(timestamp) && Number.isSafeInteger(count) && count >= 0)
    .sort((a, b) => a.timestamp - b.timestamp)
  const first = sessions[0]?.timestamp
  const last = sessions.at(-1)?.timestamp
  const date = new Intl.DateTimeFormat(options.locale, {
    timeZone: options.timeZone, year: 'numeric', month: 'short', day: 'numeric',
  })
  const multipleDays = first !== undefined && last !== undefined && date.format(first) !== date.format(last)
  const bucketMs = first !== undefined && last !== undefined && last - first > 86_400_000 ? 3_600_000 : 60_000
  const labels = new Intl.DateTimeFormat(options.locale, {
    timeZone: options.timeZone,
    ...(multipleDays ? { year: 'numeric', month: 'short', day: 'numeric' } as const : {}),
    hour: '2-digit', minute: '2-digit', timeZoneName: 'shortOffset',
  })
  const timestamps = new Intl.DateTimeFormat(options.locale, {
    timeZone: options.timeZone, year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'longOffset',
  })
  const buckets = new Map<number, number>()
  for (const { timestamp, count } of sessions) {
    const bucket = Math.floor(timestamp / bucketMs) * bucketMs
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + count)
  }
  let totalVouchers = 0
  const points: VoucherChartPoint[] = Array.from(buckets, ([timestamp, count]) => {
    totalVouchers += count
    return { timestamp, label: labels.format(timestamp), fullTimestamp: timestamps.format(timestamp), vouchers: totalVouchers }
  })
  return {
    points,
    summary: sessions.length === 0 ? 'No session data yet' :
      `${totalVouchers} vouchers across ${sessions.length} sessions opened between ${timestamps.format(first!)} and ${timestamps.format(last!)}. Current totals grouped by session opening time; not voucher arrival times.`,
  }
}
