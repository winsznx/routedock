export interface ClosableSession {
  close: () => Promise<unknown>
}

export interface SessionCloseResult {
  channelId: string
  status: 'closed' | 'error' | 'timeout'
  error?: unknown
}

export interface ShutdownSummary {
  closed: number
  failed: number
  timedOut: number
  results: SessionCloseResult[]
}

export interface CloseAllSessionsOptions {
  /** Maximum duration in ms before timing out hanging close operations. Default: 10_000 */
  timeoutMs?: number | undefined
  /** Logger for error messages (defaults to console.error) */
  logError?: ((msg: string, ...args: unknown[]) => void) | undefined
  /** Logger for informational messages (defaults to console.error, writing to stderr) */
  logInfo?: ((msg: string, ...args: unknown[]) => void) | undefined
}

export interface ClosableTransport {
  onclose?: (() => void) | undefined
}

export interface EventStream {
  once: (event: string, listener: (...args: unknown[]) => void) => unknown
}

export interface SetupShutdownHandlersOptions {
  openSessions: Map<string, ClosableSession>
  transport?: ClosableTransport | undefined
  stdin?: EventStream | undefined
  processObj?: EventStream | undefined
  timeoutMs?: number | undefined
  logError?: ((msg: string, ...args: unknown[]) => void) | undefined
  logInfo?: ((msg: string, ...args: unknown[]) => void) | undefined
  onExit?: ((code: number) => void) | undefined
}

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000

/**
 * Closes all open session handles concurrently with a bounded timeout.
 * Removes handles from the openSessions map as they finish or time out.
 */
export async function closeAllSessions(
  openSessions: Map<string, ClosableSession>,
  options: CloseAllSessionsOptions = {}
): Promise<ShutdownSummary> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
  const logError = options.logError ?? console.error
  const logInfo = options.logInfo ?? console.error

  const entries = Array.from(openSessions.entries())
  if (entries.length === 0) {
    return { closed: 0, failed: 0, timedOut: 0, results: [] }
  }

  logInfo(`[mcp-server] Closing ${entries.length} active session(s)...`)

  interface SessionTracker {
    channelId: string
    session: ClosableSession
    status: 'pending' | 'closed' | 'error' | 'timeout'
    error?: unknown
  }

  const trackers: SessionTracker[] = entries.map(([channelId, session]) => ({
    channelId,
    session,
    status: 'pending',
    error: undefined,
  }))

  const closePromises = trackers.map(async (tracker) => {
    try {
      await tracker.session.close()
      tracker.status = 'closed'
      openSessions.delete(tracker.channelId)
      logInfo(`[mcp-server] Successfully closed session ${tracker.channelId}`)
    } catch (err) {
      tracker.status = 'error'
      tracker.error = err
      openSessions.delete(tracker.channelId)
      logError(`[mcp-server] Failed to close session ${tracker.channelId}:`, err)
    }
  })

  let timer: NodeJS.Timeout | undefined
  const timeoutPromise = new Promise<'TIMEOUT'>((resolve) => {
    timer = setTimeout(() => resolve('TIMEOUT'), timeoutMs)
  })

  const allFinishedPromise = Promise.all(closePromises).then(() => 'DONE' as const)
  const outcome = await Promise.race([allFinishedPromise, timeoutPromise])

  if (timer) {
    clearTimeout(timer)
  }

  if (outcome === 'TIMEOUT') {
    for (const tracker of trackers) {
      if (tracker.status === 'pending') {
        tracker.status = 'timeout'
        openSessions.delete(tracker.channelId)
        logError(
          `[mcp-server] Timed out waiting to close session ${tracker.channelId} after ${timeoutMs}ms`
        )
      }
    }
  }

  const results: SessionCloseResult[] = trackers.map((t) => {
    const status: SessionCloseResult['status'] =
      t.status === 'pending' ? 'timeout' : t.status
    return {
      channelId: t.channelId,
      status,
      error: t.error,
    }
  })

  const closed = results.filter((r) => r.status === 'closed').length
  const failed = results.filter((r) => r.status === 'error').length
  const timedOut = results.filter((r) => r.status === 'timeout').length

  return { closed, failed, timedOut, results }
}

/**
 * Registers process signal handlers (SIGINT, SIGTERM) and transport/stdin close
 * listeners to ensure open session channels are closed before exit.
 *
 * Returns a function to trigger shutdown programmatically.
 */
export function setupShutdownHandlers(
  options: SetupShutdownHandlersOptions
): (reason?: string) => Promise<ShutdownSummary> {
  const {
    openSessions,
    transport,
    stdin = process.stdin,
    processObj = process,
    timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
    logError = console.error,
    logInfo = console.error,
    onExit = (code: number) => {
      process.exit(code)
    },
  } = options

  let shutdownPromise: Promise<ShutdownSummary> | null = null

  const handleShutdown = (reason: string): Promise<ShutdownSummary> => {
    if (shutdownPromise) {
      return shutdownPromise
    }

    logInfo(`[mcp-server] Graceful shutdown initiated (${reason})`)
    shutdownPromise = (async () => {
      try {
        const summary = await closeAllSessions(openSessions, {
          timeoutMs,
          logError,
          logInfo,
        })
        const exitCode = summary.failed > 0 || summary.timedOut > 0 ? 1 : 0
        onExit(exitCode)
        return summary
      } catch (err) {
        logError('[mcp-server] Unexpected error during shutdown:', err)
        onExit(1)
        throw err
      }
    })()

    return shutdownPromise
  }

  processObj.once('SIGINT', () => {
    void handleShutdown('SIGINT')
  })
  processObj.once('SIGTERM', () => {
    void handleShutdown('SIGTERM')
  })

  if (stdin && typeof stdin.once === 'function') {
    stdin.once('end', () => {
      void handleShutdown('stdin end')
    })
  }

  if (transport) {
    const prevOnClose = transport.onclose
    transport.onclose = () => {
      if (typeof prevOnClose === 'function') {
        prevOnClose()
      }
      void handleShutdown('transport onclose')
    }
  }

  return (reason = 'manual') => handleShutdown(reason)
}
