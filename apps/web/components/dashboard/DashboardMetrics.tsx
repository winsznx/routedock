'use client'

import { useCallback, useEffect, useState } from 'react'
import { getSupabaseBrowserClient } from '@/lib/supabase'
import { toDashboardMetrics, type DashboardStatsRow } from '@/lib/dashboardMetrics'
import { MetricCard } from '@/components/dashboard/MetricCard'

interface DashboardMetricsProps {
  initialStats: DashboardStatsRow | null
}

function timeAgo(date: string, now: number): string {
  const seconds = Math.floor((now - new Date(date).getTime()) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ago`
}

/**
 * The four metric cards. They poll `public_dashboard_stats` every 10 s, the same
 * shape as `SessionTable`, so the cards and the table below them agree instead
 * of drifting apart. `timeAgo` depends on `Date.now()`, so the relative time is
 * only rendered after mount to keep the server and client markup identical.
 */
export function DashboardMetrics({ initialStats }: DashboardMetricsProps) {
  const [stats, setStats] = useState<DashboardStatsRow | null>(initialStats)
  const [now, setNow] = useState<number | null>(null)

  const refreshStats = useCallback(async () => {
    const supabase = getSupabaseBrowserClient()
    const { data } = await supabase.from('public_dashboard_stats').select('*').maybeSingle()
    if (data) setStats(data as DashboardStatsRow)
  }, [])

  useEffect(() => {
    // `set-state-in-effect` (error in eslint-plugin-react-hooks v6) forbids a
    // synchronous setState in the effect body, so the first clock tick is
    // deferred like the initial refresh. `now` stays null on the first paint,
    // which keeps the server and client markup identical.
    const initialRefresh = setTimeout(() => {
      void refreshStats()
      setNow(Date.now())
    }, 0)
    const refreshInterval = setInterval(() => void refreshStats(), 10_000)
    const clockInterval = setInterval(() => setNow(Date.now()), 10_000)
    return () => {
      clearTimeout(initialRefresh)
      clearInterval(refreshInterval)
      clearInterval(clockInterval)
    }
  }, [refreshStats])

  const metrics = toDashboardMetrics(stats)
  const lastSettlement = metrics.lastSettlement

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      <MetricCard
        label="Active Sessions"
        value={metrics.activeSessions}
        sublabel="open channels"
        live
      />
      <MetricCard
        label="Vouchers Accumulated"
        value={metrics.totalVouchers.toLocaleString('en-US')}
        sublabel="across open sessions"
        live
      />
      <MetricCard
        label="Total Settled (USDC)"
        value={`$${metrics.totalSettled.toFixed(4)}`}
        sublabel="closed sessions"
      />
      {lastSettlement ? (
        <MetricCard
          label="Last Settlement"
          value={now === null ? '—' : timeAgo(lastSettlement.updated_at, now)}
          sublabel={`${lastSettlement.settlement_tx_hash.slice(0, 8)}...`}
        />
      ) : (
        <MetricCard label="Last Settlement" value="—" />
      )}
    </div>
  )
}
