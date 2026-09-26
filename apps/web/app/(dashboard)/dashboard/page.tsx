import type { Metadata } from 'next'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Dashboard',
  description: 'Live view of RouteDock payment sessions, transactions, and voucher activity on Stellar testnet.',
}

import { getSupabaseServerClient } from '@/lib/supabase'
import { DashboardHeader } from '@/components/layout/DashboardHeader'
import { DashboardMetrics } from '@/components/dashboard/DashboardMetrics'
import { SessionTable } from '@/components/dashboard/SessionTable'
import { TxFeed } from '@/components/dashboard/TxFeed'
import { VoucherChart } from '@/components/dashboard/VoucherChart'
import type { DashboardStatsRow } from '@/lib/dashboardMetrics'
import type { Session, TxLogEntry } from '@/lib/supabase'

async function fetchDashboardData() {
  const supabase = getSupabaseServerClient()

  const [sessionsRes, txLogRes, statsRes] = await Promise.all([
    supabase
      .from('public_sessions')
      .select('*')
      .order('opened_at', { ascending: false })
      .limit(50),
    supabase
      .from('tx_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20),
    supabase.from('public_dashboard_stats').select('*').maybeSingle(),
  ])

  if (sessionsRes.error) {
    console.error('[dashboard] failed to load public_sessions:', sessionsRes.error.message)
  }
  if (txLogRes.error) {
    console.error('[dashboard] failed to load tx_log:', txLogRes.error.message)
  }
  if (statsRes.error) {
    console.error('[dashboard] failed to load public_dashboard_stats:', statsRes.error.message)
  }

  const sessions = (sessionsRes.data ?? []) as Session[]
  const txLog = (txLogRes.data ?? []) as TxLogEntry[]
  const stats = (statsRes.data ?? null) as DashboardStatsRow | null

  return {
    sessions,
    txLog,
    stats,
    hasError: Boolean(sessionsRes.error || txLogRes.error || statsRes.error),
  }
}

export default async function DashboardPage() {
  const { sessions, txLog, stats, hasError } = await fetchDashboardData()

  return (
    <div className="min-h-screen bg-[var(--bg-base)]">
      <DashboardHeader />

      <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        {hasError && (
          <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-400">
            Some dashboard data could not be loaded from the registry. Figures below may be
            incomplete — check server logs for details.
          </div>
        )}

        {/* Metric cards — server-seeded from the aggregate view, polled client-side */}
        <DashboardMetrics initialStats={stats} />

        {/* Session table + Tx feed */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2">
            <SessionTable initialSessions={sessions} />
          </div>
          <div className="lg:col-span-1 min-h-[400px]">
            <TxFeed initialEntries={txLog} />
          </div>
        </div>

        {/* Voucher chart */}
        <VoucherChart />
      </main>
    </div>
  )
}
