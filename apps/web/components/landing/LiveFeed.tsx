'use client'

import { useEffect, useState } from 'react'
import { getSupabaseBrowserClient, type TxLogEntry } from '@/lib/supabase'
import { ModeBadge } from '@/components/shared/ModeBadge'
import { TxHashLink } from '@/components/shared/TxHashLink'

function timeAgo(date: string): string {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.floor(minutes / 60)}h ago`
}

function isPaymentMode(mode: string | null): mode is 'x402' | 'mpp-charge' | 'mpp-session' {
  return mode === 'x402' || mode === 'mpp-charge' || mode === 'mpp-session'
}

interface LiveFeedProps {
  initialEntries?: TxLogEntry[]
}

export function LiveFeed({ initialEntries = [] }: LiveFeedProps) {
  const [entries, setEntries] = useState<TxLogEntry[]>(initialEntries)

  useEffect(() => {
    async function poll() {
      const supabase = getSupabaseBrowserClient()
      const { data } = await supabase
        .from('tx_log')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(5)
      if (data) setEntries(data as TxLogEntry[])
    }

    void poll()
    const interval = setInterval(() => void poll(), 10_000)
    return () => clearInterval(interval)
  }, [])

  if (entries.length === 0) {
    return (
      <div className="rounded-2xl border border-white/5 bg-[#101A33] p-6">
        <div className="flex items-center gap-2 mb-4">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--status-success)] animate-pulse" />
          <span className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider">
            Live Feed
          </span>
        </div>
        <p className="text-sm text-[var(--text-muted)]">Waiting for transactions...</p>
      </div>
    )
  }

  return (
    <div className="rounded-2xl border border-white/5 bg-[#101A33] p-6">
      <div className="flex items-center gap-2 mb-4">
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--status-success)] animate-pulse" />
        <span className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider">
          Live Feed — Testnet
        </span>
      </div>
      <ul className="space-y-3">
        {entries.map((entry) => (
          <li key={entry.id} className="flex items-center gap-3">
            {isPaymentMode(entry.mode) ? (
              <ModeBadge mode={entry.mode} />
            ) : (
              <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-white/5 text-white/40">
                {entry.tx_type}
              </span>
            )}
            <span className="text-xs text-[var(--text-muted)] flex-1 truncate">
              {entry.amount != null && (
                <span className="font-mono text-[var(--text-secondary)]">
                  ${Number(entry.amount).toFixed(4)}
                </span>
              )}{' '}
              {entry.tx_type === 'channel_open' ? 'opened' : entry.tx_type === 'channel_close' ? 'closed' : entry.tx_type === 'policy_reject' ? 'rejected' : 'settled'}
            </span>
            {entry.tx_hash && (
              <TxHashLink hash={entry.tx_hash} network={entry.network} />
            )}
            <span className="text-xs text-[var(--text-muted)] shrink-0">
              {timeAgo(entry.created_at)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
