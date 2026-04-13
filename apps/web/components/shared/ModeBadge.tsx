import { cn } from '@/lib/utils'

type PaymentMode = 'x402' | 'mpp-charge' | 'mpp-session'

const MODE_CONFIG: Record<PaymentMode, { label: string; className: string }> = {
  x402: {
    label: 'x402',
    className: 'bg-[var(--accent-subtle)] text-[var(--accent)]',
  },
  'mpp-charge': {
    label: 'MPP Charge',
    className: 'bg-violet-500/10 text-violet-400 dark:text-[#A78BFA]',
  },
  'mpp-session': {
    label: 'MPP Session',
    className: 'bg-emerald-500/10 text-[var(--status-success)]',
  },
}

interface ModeBadgeProps {
  mode: PaymentMode
  className?: string
}

export function ModeBadge({ mode, className }: ModeBadgeProps) {
  const config = MODE_CONFIG[mode]
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        config.className,
        className,
      )}
    >
      {config.label}
    </span>
  )
}
