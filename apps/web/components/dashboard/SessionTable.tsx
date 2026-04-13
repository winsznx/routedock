'use client'

import { useEffect, useState } from 'react'
import { getSupabaseBrowserClient, type Session } from '@/lib/supabase'
import { AddressDisplay } from '@/components/shared/AddressDisplay'
import { ModeBadge } from '@/components/shared/ModeBadge'
import { TxHashLink } from '@/components/shared/TxHashLink'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

function timeAgo(date: string): string {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

type StatusVariant = 'success' | 'warning' | 'neutral'

const STATUS_VARIANT: Record<Session['status'], StatusVariant> = {
  open: 'success',
  closing: 'warning',
  closed: 'neutral',
}

interface SessionTableProps {
  initialSessions?: Session[]
}

export function SessionTable({ initialSessions = [] }: SessionTableProps) {
  const [sessions, setSessions] = useState<Session[]>(initialSessions)

  useEffect(() => {
    const supabase = getSupabaseBrowserClient()

    const channel = supabase
      .channel('sessions-realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'sessions' },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            setSessions((prev) => [payload.new as Session, ...prev])
          } else if (payload.eventType === 'UPDATE') {
            setSessions((prev) =>
              prev.map((s) =>
                s.id === (payload.new as Session).id ? (payload.new as Session) : s,
              ),
            )
          } else if (payload.eventType === 'DELETE') {
            setSessions((prev) =>
              prev.filter((s) => s.id !== (payload.old as Session).id),
            )
          }
        },
      )
      .subscribe()

    return () => {
      void supabase.removeChannel(channel)
    }
  }, [])

  return (
    <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)]">
      <div className="px-5 py-4 border-b border-[var(--border-default)]">
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">Sessions</h2>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b border-[var(--border-default)] bg-[var(--bg-subtle)]">
              <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider">
                Channel
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider">
                Payer
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider">
                Mode
              </th>
              <th className="px-4 py-3 text-right text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider">
                Vouchers
              </th>
              <th className="px-4 py-3 text-right text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider">
                Cumulative USDC
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider">
                Status
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider">
                Settlement Tx
              </th>
              <th className="px-4 py-3 text-right text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider">
                Opened
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border-default)]">
            {sessions.length === 0 ? (
              <tr>
                <td
                  colSpan={8}
                  className="px-4 py-12 text-center text-sm text-[var(--text-muted)]"
                >
                  No sessions yet.
                </td>
              </tr>
            ) : (
              sessions.map((session) => (
                <tr
                  key={session.id}
                  className="hover:bg-[var(--bg-subtle)] transition-colors"
                >
                  <td className="px-4 py-3">
                    <AddressDisplay address={session.channel_id} />
                  </td>
                  <td className="px-4 py-3">
                    <AddressDisplay address={session.payer} />
                  </td>
                  <td className="px-4 py-3">
                    <ModeBadge mode="mpp-session" />
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-xs text-[var(--text-primary)]">
                    {session.voucher_count}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span
                      className={cn(
                        'number-lg text-[var(--text-primary)]',
                        session.status === 'open' && 'text-[var(--status-success)]',
                      )}
                    >
                      {Number(session.cumulative_amount).toFixed(7)}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1.5">
                      {session.status === 'open' && (
                        <span className="h-1.5 w-1.5 rounded-full bg-[var(--status-success)] animate-pulse" />
                      )}
                      <Badge variant={STATUS_VARIANT[session.status]}>
                        {session.status}
                      </Badge>
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {session.settlement_tx_hash ? (
                      <TxHashLink
                        hash={session.settlement_tx_hash}
                        network={session.network}
                      />
                    ) : (
                      <span className="text-xs text-[var(--text-muted)]">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right text-xs text-[var(--text-muted)]">
                    {timeAgo(session.opened_at)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
