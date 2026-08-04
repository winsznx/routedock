import type { ReactNode } from 'react'

interface MetricCardProps {
  label: string
  value: string | number
  sublabel?: string | undefined
  icon?: ReactNode | undefined
  live?: boolean | undefined
}

export function MetricCard({ label, value, sublabel, icon, live }: MetricCardProps) {
  return (
    <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-5">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider">
          {label}
        </span>
        <div className="flex items-center gap-2">
          {icon}
          {live && (
            <span
              className="h-2 w-2 rounded-full bg-[var(--status-success)] animate-pulse"
              aria-hidden="true"
            />
          )}
        </div>
      </div>
      <div className="number-xl text-[var(--text-primary)]">{value}</div>
      {sublabel && (
        <div className="mt-1 text-xs text-[var(--text-muted)]">{sublabel}</div>
      )}
    </div>
  )
}
