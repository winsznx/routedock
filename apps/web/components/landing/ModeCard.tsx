import type { ReactNode } from 'react'
import { ModeBadge } from '@/components/shared/ModeBadge'

type PaymentMode = 'x402' | 'mpp-charge' | 'mpp-session'

interface ModeCardProps {
  mode: PaymentMode
  title: string
  description: string
  icon: ReactNode
  stats: string
}

export function ModeCard({ mode, title, description, icon, stats }: ModeCardProps) {
  return (
    <div className="group rounded-2xl border border-white/5 bg-[#101A33] p-6 transition-colors hover:border-white/10 flex flex-col gap-4">
      <div className="flex items-start justify-between">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/5 text-[var(--text-secondary)]">
          {icon}
        </div>
        <ModeBadge mode={mode} />
      </div>
      <div className="flex-1">
        <h3 className="font-semibold text-[var(--text-primary)] mb-2">{title}</h3>
        <p className="text-sm text-[var(--text-muted)] leading-relaxed">{description}</p>
      </div>
      <p className="text-xs font-medium text-[var(--text-secondary)] border-t border-white/5 pt-4">
        {stats}
      </p>
    </div>
  )
}
