'use client'

import { useCallback, useEffect, useState } from 'react'
import { getSupabaseBrowserClient } from '@/lib/supabase'
import { toDashboardMetrics, type DashboardStatsRow } from '@/lib/dashboardMetrics'
import { MetricCard } from '@/components/dashboard/MetricCard'
import { RelativeTime } from '@/components/shared/RelativeTime'

interface DashboardMetricsProps {
  initialStats: DashboardStatsRow | null
}

/**
 * The four metric cards. They poll `public_dashboard_stats` every 10 s, the same
 * shape as `SessionTable`, so the cards and the table below them agree instead
 * of drifting apart. The "Last Settlement" card renders the shared
 * `RelativeTime`, which keeps the server and client markup identical until it
 * mounts.
 */
export function DashboardMetrics({ initialStats }: DashboardMetricsProps) {
  const [stats, setStats] = useState<DashboardStatsRow | null>(initialStats)

  const refreshStats = useCallback(async () => {
    const supabase = getSupabaseBrowserClient()
    const { data } = await supabase.from('public_dashboard_stats').select('*').maybeSingle()
    if (data) setStats(data as DashboardStatsRow)
  }, [])

  useEffect(() => {
    // `set-state-in-effect` (error in eslint-plugin-react-hooks v6) forbids a
    // synchronous setState in the effect body, so the first refresh is deferred.
    const initialRefresh = setTimeout(() => {
      void refreshStats()
    }, 0)
    const refreshInterval = setInterval(() => void refreshStats(), 10_000)
    return () => {
      clearTimeout(initialRefresh)
      clearInterval(refreshInterval)
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
          value={<RelativeTime date={lastSettlement.updated_at} />}
          sublabel={`${lastSettlement.settlement_tx_hash.slice(0, 8)}...`}
        />
      ) : (
        <MetricCard label="Last Settlement" value="—" />
      )}
    </div>
  )
}
