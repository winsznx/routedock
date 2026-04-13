import { ExternalLink } from 'lucide-react'

const EXPLORER_URL =
  process.env.NEXT_PUBLIC_STELLAR_EXPERT_URL ?? 'https://stellar.expert/explorer/testnet'

export function DashboardHeader() {
  return (
    <header className="border-b border-[var(--border-default)] bg-[var(--bg-surface)]">
      <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
        <div className="flex h-14 items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="font-bold text-[var(--text-primary)] tracking-tight">
              Route<span className="text-[var(--accent)]">Dock</span>
            </span>
            <span className="hidden sm:inline-flex items-center gap-1.5 rounded-full border border-[var(--status-success)]/30 bg-[var(--status-success)]/10 px-2.5 py-0.5 text-xs font-medium text-[var(--status-success)]">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--status-success)] animate-pulse" />
              Testnet Live
            </span>
          </div>

          <a
            href={EXPLORER_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
          >
            Stellar Expert
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      </div>
    </header>
  )
}
