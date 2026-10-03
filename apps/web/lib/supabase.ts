import { createClient } from '@supabase/supabase-js'

// Read inside the function (not at module scope) so a missing/empty value is
// caught on every call and tests can stub process.env per case. The literal
// `process.env.NEXT_PUBLIC_...` accesses matter: Next.js inlines NEXT_PUBLIC_*
// values into the browser bundle by matching this exact syntax at build time,
// so a dynamic lookup like `process.env[name]` would be undefined in the
// browser even when the variable is set.
function requireSupabaseConfig(): { url: string; anonKey: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

  if (!url || !anonKey) {
    const missing: string[] = []
    if (!url) missing.push('NEXT_PUBLIC_SUPABASE_URL')
    if (!anonKey) missing.push('NEXT_PUBLIC_SUPABASE_ANON_KEY')
    throw new Error(
      `Missing ${missing.join(', ')}. Copy apps/web/.env.example to apps/web/.env.local and restart the dev server.`,
    )
  }

  return { url, anonKey }
}

// Browser singleton — safe to call multiple times (same instance returned)
let browserClient: ReturnType<typeof createClient> | null = null

export function getSupabaseBrowserClient() {
  if (!browserClient) {
    const { url, anonKey } = requireSupabaseConfig()
    browserClient = createClient(url, anonKey)
  }
  return browserClient
}

// Server-side client (plain, no singleton — each call gets a fresh instance)
export function getSupabaseServerClient() {
  const { url, anonKey } = requireSupabaseConfig()
  return createClient(url, anonKey)
}

// ── Database types from Section 8 schema ──────────────────────────────────────

/**
 * Explicit column list for the `public_sessions` view.
 *
 * `cumulative_amount` is cast to text on purpose: the column is NUMERIC(20,7) and
 * PostgREST otherwise hands supabase-js a JSON number. `String()` on any value below
 * 1e-6 yields exponent form ("5e-7"), which `usdcToStroops` rejects. Postgres renders
 * NUMERIC as plain decimal text ("0.0000005"), so selecting it as text keeps the amount
 * in a format the parser accepts.
 */
export const SESSION_COLUMNS =
  'id, channel_id, payee, payer, cumulative_amount::text, status, network, opened_at, updated_at, settlement_tx_hash, open_tx_hash, voucher_count'

export interface Session {
  id: string
  channel_id: string
  payee: string
  payer: string
  /** Decimal USDC as text, e.g. "0.0000005" — see {@link SESSION_COLUMNS}. */
  cumulative_amount: string
  status: 'open' | 'closing' | 'closed'
  network: string
  opened_at: string
  updated_at: string
  settlement_tx_hash: string | null
  open_tx_hash: string | null
  voucher_count: number
}

export interface TxLogEntry {
  id: string
  session_id: string | null
  tx_type: 'x402_settle' | 'mpp_charge' | 'channel_open' | 'channel_close' | 'policy_reject'
  tx_hash: string | null
  amount: number | null
  mode: string | null
  network: string
  provider_url: string | null
  agent_address: string | null
  metadata: Record<string, unknown> | null
  created_at: string
}
