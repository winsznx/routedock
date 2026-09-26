'use client'

import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { getSupabaseBrowserClient, type TxLogEntry } from '@/lib/supabase'
import { mergeTxEntries } from '@/lib/mergeTxEntries'
import { ModeBadge } from '@/components/shared/ModeBadge'
import { TxHashLink } from '@/components/shared/TxHashLink'

const MAX_ENTRIES = 20
const FALLBACK_POLL_MS = 10_000

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
  const [paused, setPaused] = useState(false)

  useEffect(() => {
    const supabase = getSupabaseBrowserClient()
    let disposed = false
    let pollTimer: ReturnType<typeof setInterval> | null = null

    function stopPolling() {
      if (pollTimer !== null) {
        clearInterval(pollTimer)
        pollTimer = null
      }
    }

    // Same query the dashboard page uses for its SSR snapshot.
    async function fetchLatest(): Promise<TxLogEntry[] | null> {
      const { data, error } = await supabase
        .from('tx_log')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(MAX_ENTRIES)

      if (error) {
        console.warn('[tx-feed] failed to refresh tx_log:', error.message)
        return null
      }
      return (data ?? []) as TxLogEntry[]
    }

    // A failed refetch keeps the rows already on screen.
    async function refresh() {
      const rows = await fetchLatest()
      if (disposed || rows === null) return
      setEntries((prev) => mergeTxEntries(prev, rows, MAX_ENTRIES))
    }

    // Only one fallback interval at a time.
    function startPolling() {
      if (pollTimer !== null) return
      pollTimer = setInterval(() => void refresh(), FALLBACK_POLL_MS)
    }

    const channel = supabase
      .channel('txlog-realtime')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'tx_log' },
        (payload) => {
          setEntries((prev) =>
            mergeTxEntries(prev, [payload.new as TxLogEntry], MAX_ENTRIES),
          )
        },
      )
      .subscribe((status: string, err?: Error) => {
        if (disposed) return

        if (status === 'SUBSCRIBED') {
          setPaused(false)
          stopPolling()
          // postgres_changes has no replay: backfill the gap between the SSR
          // snapshot and the channel going live, plus anything missed while the
          // socket was down.
          void refresh()
          return
        }

        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          console.warn('[tx-feed] realtime channel', status, err?.message ?? '')
          setPaused(true)
          startPolling()
        }
      })

    return () => {
      // removeChannel fires a CLOSED status of its own; ignore it so we don't
      // start a poll on an unmounted component.
      disposed = true
      stopPolling()
      void supabase.removeChannel(channel)
    }
  }, [])

  return (
    <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] flex flex-col max-h-[420px]">
      <div className="px-5 py-4 border-b border-[var(--border-default)] shrink-0">
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">Transaction Feed</h2>
        {paused && (
          <p className="mt-1 text-xs text-[var(--status-pending)]">Live updates paused</p>
        )}
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
