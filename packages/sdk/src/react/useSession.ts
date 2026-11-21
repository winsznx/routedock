import { useCallback, useEffect, useRef, useState } from 'react'
import { RouteDockChannelStateError } from '../errors.js'
import type {
  SessionCloseResult,
  SessionHandle,
  SessionOptions,
  StreamOptions,
} from '../types.js'
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
  /**
   * Async iterable wrapper around `session.stream(streamOptions)` that updates
   * `vouchers` and `cumulative` from `session.stats()` as each item arrives.
   */
  stream: (streamOptions?: StreamOptions) => AsyncIterable<unknown>
  /**
   * Pull the latest `vouchers` and `cumulative` from `session.stats()`. Useful
   * for callers iterating `session.stream()` directly.
   */
  refreshStats: () => void
}

/**
 * Manages MPP session lifecycle. Forwards `SessionOptions` (`mode`,
 * `maxDurationMs`, `store`) to `client.openSession()`, tracks live `vouchers`
 * and `cumulative` spend when iterating via `stream()` or calling
 * `refreshStats()`, and reacts to `session:timeout`, `session:closed`, and
 * `session:close-failed` lifecycle events. On unmount, fires `session.close()`
 * in the background if a session is still open (best-effort settlement).
 *
 * @example
 * const { open, stream, close, vouchers, cumulative, status } = useSession(streamUrl, {
 *   mode: 'mpp-session-ws',
 *   maxDurationMs: 60_000,
 * })
 */
export function useSession(url: string, options?: SessionOptions): UseSessionResult {
  const { client } = useRouteDockContext()
  const [session, setSession] = useState<SessionHandle | null>(null)
  const [status, setStatus] = useState<SessionStatus>('idle')
  const [vouchers, setVouchers] = useState(0)
  const [cumulative, setCumulative] = useState('0')
  const [error, setError] = useState<Error | null>(null)
  const mountedRef = useRef(true)
  const sessionRef = useRef<SessionHandle | null>(null)
  const unsubscribeRef = useRef<Array<() => void>>([])
  const lastCloseResultRef = useRef<SessionCloseResult | null>(null)

  const hasOptions = options !== undefined
  const mode = options?.mode
  const maxDurationMs = options?.maxDurationMs
  const store = options?.store

  const clearSubscriptions = useCallback((): void => {
    for (const unsubscribe of unsubscribeRef.current) {
      unsubscribe()
    }
    unsubscribeRef.current = []
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      clearSubscriptions()
      const s = sessionRef.current
      if (s) {
        s.close().catch(() => {
          /* unmount best-effort */
        })
        sessionRef.current = null
      }
    }
  }, [clearSubscriptions])

  const open = useCallback(async (): Promise<SessionHandle | null> => {
    setStatus('opening')
    setError(null)
    try {
      const sessionOptions: SessionOptions | undefined = hasOptions
        ? {
            ...(mode !== undefined ? { mode } : {}),
            ...(maxDurationMs !== undefined ? { maxDurationMs } : {}),
            ...(store !== undefined ? { store } : {}),
          }
        : undefined
      const s =
        sessionOptions !== undefined
          ? await client.openSession(url, sessionOptions)
          : await client.openSession(url)

      clearSubscriptions()
      lastCloseResultRef.current = null
      sessionRef.current = s

      const unsubTimeout = s.on('session:timeout', () => {
        if (sessionRef.current !== s) return
        if (mountedRef.current) {
          setStatus('closing')
        }
      })
      const unsubClosed = s.on('session:closed', (result) => {
        if (sessionRef.current !== s) return
        clearSubscriptions()
        sessionRef.current = null
        lastCloseResultRef.current = result
        if (mountedRef.current) {
          setSession(null)
          setStatus('closed')
          setVouchers(result.vouchersIssued)
          setCumulative(result.totalPaid)
        }
      })
      const unsubCloseFailed = s.on('session:close-failed', ({ error: closeErr }) => {
        if (sessionRef.current !== s) return
        const e = closeErr instanceof Error ? closeErr : new Error(String(closeErr))
        if (mountedRef.current) {
          setError(e)
          setStatus('error')
        }
      })
      unsubscribeRef.current = [unsubTimeout, unsubClosed, unsubCloseFailed]

      if (mountedRef.current) {
        setSession(s)
        setStatus('open')
        setVouchers(0)
        setCumulative('0')
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
  }, [client, url, hasOptions, mode, maxDurationMs, store, clearSubscriptions])

  const refreshStats = useCallback((): void => {
    const s = sessionRef.current
    if (!s || !mountedRef.current) return
    const snapshot = s.stats()
    setVouchers(snapshot.vouchersIssued)
    setCumulative(snapshot.currentCumulative)
  }, [])

  const stream = useCallback(
    async function* (streamOptions?: StreamOptions): AsyncIterable<unknown> {
      const s = sessionRef.current
      if (!s) {
        throw new RouteDockChannelStateError('Session is not open — call open() before stream()')
      }
      const iterable = streamOptions !== undefined ? s.stream(streamOptions) : s.stream()
      for await (const item of iterable) {
        if (mountedRef.current && sessionRef.current === s) {
          const snapshot = s.stats()
          setVouchers(snapshot.vouchersIssued)
          setCumulative(snapshot.currentCumulative)
        }
        yield item
      }
      if (mountedRef.current && sessionRef.current === s) {
        const snapshot = s.stats()
        setVouchers(snapshot.vouchersIssued)
        setCumulative(snapshot.currentCumulative)
      }
    },
    [],
  )

  const close = useCallback(async (): Promise<SessionCloseResult | null> => {
    const s = sessionRef.current
    if (!s) return lastCloseResultRef.current
    setStatus('closing')
    setError(null)
    try {
      const r = await s.close()
      clearSubscriptions()
      sessionRef.current = null
      lastCloseResultRef.current = r
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
  }, [clearSubscriptions])

  return { session, status, vouchers, cumulative, error, open, close, stream, refreshStats }
}
