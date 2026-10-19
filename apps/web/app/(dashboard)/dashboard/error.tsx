'use client'

import { useEffect } from 'react'

/**
 * Route-level error boundary for /dashboard.
 *
 * The dashboard reads aggregate figures and the latest sessions from Supabase,
 * so any unhandled throw here would otherwise take the page down for every
 * visitor. The metrics mapper already tolerates a missing or null stats row;
 * this boundary is the backstop for anything else (Supabase client failure,
 * rendering error).
 */
export default function DashboardError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string }
  unstable_retry: () => void
}) {
  useEffect(() => {
    console.error('[dashboard] render failed:', error)
  }, [error])

  return (
    <div className="min-h-screen bg-[var(--bg-base)] px-4 py-16">
      <div className="mx-auto max-w-md rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] px-6 py-8 text-center">
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">
          Could not load the dashboard
        </h2>
        <p className="mt-2 text-sm text-[var(--text-secondary)]">
          The session data could not be read. This is usually temporary — try again.
        </p>
        {error.digest ? (
          <p className="mt-2 font-mono text-xs text-[var(--text-muted)]">
            Reference: {error.digest}
          </p>
        ) : null}
        <button
          type="button"
          onClick={() => unstable_retry()}
          className="mt-6 rounded-lg bg-[var(--text-primary)] px-4 py-2 text-sm font-medium text-[var(--bg-base)] transition-opacity hover:opacity-90"
        >
          Try again
        </button>
      </div>
    </div>
  )
}
