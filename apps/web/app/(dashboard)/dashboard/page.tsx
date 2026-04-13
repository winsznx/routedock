export const dynamic = 'force-dynamic'

import { getSupabaseServerClient } from '@/lib/supabase'
import { DashboardHeader } from '@/components/layout/DashboardHeader'
import { MetricCard } from '@/components/dashboard/MetricCard'
import { SessionTable } from '@/components/dashboard/SessionTable'
import { TxFeed } from '@/components/dashboard/TxFeed'
import { VoucherChart } from '@/components/dashboard/VoucherChart'
import type { Session, TxLogEntry } from '@/lib/supabase'

async function fetchDashboardData() {
  const supabase = getSupabaseServerClient()

  const [sessionsRes, txLogRes] = await Promise.all([
    supabase
      .from('sessions')
      .select('*')
      .order('opened_at', { ascending: false })
      .limit(50),
    supabase
      .from('tx_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(20),
  ])

  const sessions = (sessionsRes.data ?? []) as Session[]
  const txLog = (txLogRes.data ?? []) as TxLogEntry[]

  const activeSessions = sessions.filter((s) => s.status === 'open')
  const totalVouchers = sessions.reduce((sum, s) => sum + (s.voucher_count ?? 0), 0)
  const totalSettled = sessions
    .filter((s) => s.status === 'closed')
    .reduce((sum, s) => sum + Number(s.cumulative_amount ?? 0), 0)

  const lastSettlement = sessions
    .filter((s) => s.status === 'closed' && s.settlement_tx_hash)
    .at(0)

  return { sessions, txLog, activeSessions, totalVouchers, totalSettled, lastSettlement }
}

function timeAgo(date: string): string {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ago`
}

export default async function DashboardPage() {
  const { sessions, txLog, activeSessions, totalVouchers, totalSettled, lastSettlement } =
    await fetchDashboardData()

  return (
    <div className="min-h-screen bg-[var(--bg-base)]">
      <DashboardHeader />

      <main className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-8 space-y-6">
        {/* Metric cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <MetricCard
            label="Active Sessions"
            value={activeSessions.length}
            sublabel="open channels"
            live
          />
          <MetricCard
            label="Vouchers Accumulated"
            value={totalVouchers.toLocaleString()}
            sublabel="across open sessions"
            live
          />
          <MetricCard
            label="Total Settled (USDC)"
            value={`$${totalSettled.toFixed(4)}`}
            sublabel="closed sessions"
          />
          {lastSettlement?.settlement_tx_hash ? (
            <MetricCard
              label="Last Settlement"
              value={timeAgo(lastSettlement.updated_at)}
              sublabel={`${lastSettlement.settlement_tx_hash.slice(0, 8)}...`}
            />
          ) : (
            <MetricCard
              label="Last Settlement"
              value="—"
            />
          )}
        </div>

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
