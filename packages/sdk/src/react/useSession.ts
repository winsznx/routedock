import { useCallback, useEffect, useRef, useState } from 'react'
import type { SessionHandle, SessionCloseResult } from '../types.js'
import { useRouteDockContext } from './context.js'

export type SessionStatus = 'idle' | 'opening' | 'open' | 'closing' | 'closed' | 'error'

export interface UseSessionResult {
  session: SessionHandle | null
  status: SessionStatus
  vouchers: number
  cumulative: string
  error: Error | null
  open: () => Promise<SessionHandle | null>
  close: () => Promise<SessionCloseResult | null>
}

/**
 * Manages MPP session lifecycle. On unmount, fires session.close() in the
 * background if status === 'open' (best-effort settlement).
 *
 * @example
 * const { session, open, close, vouchers, cumulative, status } = useSession(streamUrl)
 * useEffect(() => { open() }, [])
 */
export function useSession(url: string): UseSessionResult {
  const { client } = useRouteDockContext()
  const [session, setSession] = useState<SessionHandle | null>(null)
  const [status, setStatus] = useState<SessionStatus>('idle')
  const [vouchers, setVouchers] = useState(0)
  const [cumulative, setCumulative] = useState('0')
  const [error, setError] = useState<Error | null>(null)
  const mountedRef = useRef(true)
  const sessionRef = useRef<SessionHandle | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      const s = sessionRef.current
      if (s) {
        s.close().catch(() => {
          /* unmount best-effort */
        })
        sessionRef.current = null
      }
    }
  }, [])

  const open = useCallback(async (): Promise<SessionHandle | null> => {
    setStatus('opening')
    setError(null)
    try {
      const s = await client.openSession(url)
      sessionRef.current = s
      if (mountedRef.current) {
        setSession(s)
        setStatus('open')
      }
      return s
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      if (mountedRef.current) {
        setError(e)
        setStatus('error')
      }
      return null
    }
  }, [client, url])

  const close = useCallback(async (): Promise<SessionCloseResult | null> => {
    const s = sessionRef.current
    if (!s) return null
    setStatus('closing')
    try {
      const r = await s.close()
      sessionRef.current = null
      if (mountedRef.current) {
        setSession(null)
        setStatus('closed')
        setVouchers(r.vouchersIssued)
        setCumulative(r.totalPaid)
      }
      return r
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err))
      if (mountedRef.current) {
        setError(e)
        setStatus('error')
      }
      return null
    }
  }, [])

  return { session, status, vouchers, cumulative, error, open, close }
}
