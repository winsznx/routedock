'use client'

import { useEffect, useState } from 'react'
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import type { TooltipContentProps } from 'recharts/types/component/Tooltip'
import { getSupabaseBrowserClient } from '@/lib/supabase'
import { buildVoucherSnapshot } from '@/lib/voucherChart'

function CustomTooltip(props: TooltipContentProps) {
  const { active, payload } = props
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-overlay)] p-2 text-xs shadow-lg">
      <p className="text-[var(--text-muted)] mb-0.5">{String(payload[0]?.payload.fullTimestamp)}</p>
      <p className="font-mono text-[var(--text-primary)]">
        {payload[0]?.value as number} vouchers
      </p>
    </div>
  )
}

export function VoucherChart() {
  const [snapshot, setSnapshot] = useState<ReturnType<typeof buildVoucherSnapshot>>({ points: [], summary: '' })
  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const data = snapshot.points

  useEffect(() => {
    let cancelled = false
    let fetching = false
    const fetchData = async () => {
      if (fetching) return
      fetching = true
      try {
        const { data: rows, error } = await getSupabaseBrowserClient()
          .from('public_sessions')
          .select('opened_at, voucher_count')
          .not('voucher_count', 'eq', 0)
          .order('opened_at', { ascending: false })
          .limit(500)
        if (error) throw error
        if (!cancelled) {
          setSnapshot(buildVoucherSnapshot(rows ?? []))
          setLoadFailed(false)
        }
      } catch {
        // A failed refresh must preserve the last successful snapshot.
        if (!cancelled) setLoadFailed(true)
      } finally {
        fetching = false
        if (!cancelled) setLoading(false)
      }
    }
    const initialFetch = setTimeout(() => void fetchData(), 0)
    const interval = setInterval(() => void fetchData(), 30_000)
    return () => {
      cancelled = true
      clearTimeout(initialFetch)
      clearInterval(interval)
    }
  }, [])

  if (data.length === 0) {
    return (
      <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-5">
        <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-6">
          Voucher Snapshot
        </h2>
        <div aria-busy={loading} className="flex items-center justify-center h-40">
          {loading ? (
            <p role="status" className="text-sm text-[var(--text-muted)]">Loading session data…</p>
          ) : loadFailed ? (
            <p className="text-sm text-[var(--status-error)]">
              {"Couldn't load session data"}
            </p>
          ) : (
            <p className="text-sm text-[var(--text-muted)]">No session data yet</p>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-5">
      <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-6">
        Voucher Snapshot
      </h2>
      <p className="mb-3 text-xs text-[var(--text-muted)]">
        Current totals for up to 500 sessions with vouchers, grouped by opening time in your local time zone.
        This is not a timeline of voucher arrivals.
      </p>
      <p className="sr-only">{snapshot.summary}</p>
      {loadFailed && (
        <p className="mb-3 text-xs text-[var(--status-error)]">
          {"Couldn't refresh session data. Showing the last loaded points."}
        </p>
      )}
      <ResponsiveContainer width="100%" height={200}>
        <AreaChart data={data} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
          <defs>
            <linearGradient id="accentFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="var(--accent)" stopOpacity={0.2} />
              <stop offset="95%" stopColor="var(--accent)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="var(--border-default)"
            vertical={false}
          />
          <XAxis
            dataKey="label"
            interval="preserveStartEnd"
            tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            tick={{ fill: 'var(--text-muted)', fontSize: 11 }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip content={(p) => <CustomTooltip {...p} />} />
          <Area
            type="stepAfter"
            dataKey="vouchers"
            stroke="var(--accent)"
            strokeWidth={2}
            fill="url(#accentFill)"
            isAnimationActive={false}
            dot={false}
            activeDot={{ r: 3, fill: 'var(--accent)' }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
