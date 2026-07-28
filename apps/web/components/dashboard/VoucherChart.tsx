'use client'

import { useEffect, useState, useCallback } from 'react'
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

interface ChartPoint {
  minute: string
  vouchers: number
}

function CustomTooltip(props: TooltipContentProps) {
  const { active, payload, label } = props
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-overlay)] p-2 text-xs shadow-lg">
      <p className="text-[var(--text-muted)] mb-0.5">{String(label)}</p>
      <p className="font-mono text-[var(--text-primary)]">
        {payload[0]?.value as number} vouchers
      </p>
    </div>
  )
}

export function VoucherChart() {
  const [data, setData] = useState<ChartPoint[]>([])

  const fetchData = useCallback(async () => {
    const supabase = getSupabaseBrowserClient()
    const { data: rows } = await supabase
      .from('sessions')
      .select('opened_at, voucher_count')
      .not('voucher_count', 'eq', 0)
      .order('opened_at', { ascending: true })
      .limit(500)

    if (!rows || rows.length === 0) {
      setData([])
      return
    }

    // Group by minute, cumulative voucher count
    const byMinute = new Map<string, number>()
    for (const row of rows as { opened_at: string; voucher_count: number }[]) {
      const minute = new Date(row.opened_at).toISOString().slice(0, 16)
      byMinute.set(minute, (byMinute.get(minute) ?? 0) + (row.voucher_count ?? 0))
    }

    let cumulative = 0
    const points: ChartPoint[] = Array.from(byMinute.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([iso, count]) => {
        cumulative += count
        const [, time] = iso.split('T')
        return { minute: time ?? iso, vouchers: cumulative }
      })

    setData(points)
  }, [])

  useEffect(() => {
    void fetchData()
    const interval = setInterval(() => void fetchData(), 30_000)
    return () => clearInterval(interval)
  }, [fetchData])

  if (data.length === 0) {
    return (
      <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-5">
        <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-6">
          Voucher Accumulation
        </h2>
        <div className="flex items-center justify-center h-40">
          <p className="text-sm text-[var(--text-muted)]">No session data yet</p>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-5">
      <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-6">
        Voucher Accumulation
      </h2>
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
            dataKey="minute"
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
            type="monotone"
            dataKey="vouchers"
            stroke="var(--accent)"
            strokeWidth={2}
            fill="url(#accentFill)"
            dot={false}
            activeDot={{ r: 3, fill: 'var(--accent)' }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}
