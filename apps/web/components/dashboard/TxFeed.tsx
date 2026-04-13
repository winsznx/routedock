'use client'

import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { getSupabaseBrowserClient, type TxLogEntry } from '@/lib/supabase'
import { ModeBadge } from '@/components/shared/ModeBadge'
import { TxHashLink } from '@/components/shared/TxHashLink'

const MAX_ENTRIES = 20

function timeAgo(date: string): string {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ago`
}

const TX_TYPE_LABEL: Record<TxLogEntry['tx_type'], string> = {
  x402_settle: 'settled',
  mpp_charge: 'charged',
  channel_open: 'opened',
  channel_close: 'closed',
  policy_reject: 'rejected',
}

function isPaymentMode(mode: string | null): mode is 'x402' | 'mpp-charge' | 'mpp-session' {
  return mode === 'x402' || mode === 'mpp-charge' || mode === 'mpp-session'
}

interface TxFeedProps {
  initialEntries?: TxLogEntry[]
}

export function TxFeed({ initialEntries = [] }: TxFeedProps) {
  const [entries, setEntries] = useState<TxLogEntry[]>(initialEntries)

  useEffect(() => {
    const supabase = getSupabaseBrowserClient()

    const channel = supabase
      .channel('txlog-realtime')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'tx_log' },
        (payload) => {
          setEntries((prev) => [payload.new as TxLogEntry, ...prev].slice(0, MAX_ENTRIES))
        },
      )
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [])

  return (
    <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] flex flex-col h-full">
      <div className="px-5 py-4 border-b border-[var(--border-default)] shrink-0">
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">Transaction Feed</h2>
      </div>

      <div className="flex-1 overflow-y-auto">
        {entries.length === 0 ? (
          <div className="px-5 py-8 text-center">
            <span className="inline-flex items-center gap-2 text-sm text-[var(--text-muted)]">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--text-muted)] animate-pulse" />
              Waiting for transactions...
            </span>
          </div>
        ) : (
          <ul className="divide-y divide-[var(--border-default)]">
            <AnimatePresence initial={false}>
              {entries.map((entry) => (
                <motion.li
                  key={entry.id}
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  className="px-5 py-3 flex items-start gap-3"
                >
                  <div className="shrink-0 pt-0.5">
                    {isPaymentMode(entry.mode) ? (
                      <ModeBadge mode={entry.mode} />
                    ) : (
                      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-[var(--bg-subtle)] text-[var(--text-muted)]">
                        {entry.tx_type}
                      </span>
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-[var(--text-secondary)]">
                        {TX_TYPE_LABEL[entry.tx_type]}
                        {entry.amount != null && (
                          <span className="ml-1 font-mono text-[var(--text-primary)]">
                            ${Number(entry.amount).toFixed(4)}
                          </span>
                        )}
                      </span>
                      <span className="text-xs text-[var(--text-muted)] shrink-0">
                        {timeAgo(entry.created_at)}
                      </span>
                    </div>
                    {entry.tx_hash && (
                      <div className="mt-0.5">
                        <TxHashLink hash={entry.tx_hash} network={entry.network} />
                      </div>
                    )}
                  </div>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </div>
    </div>
  )
}
