import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''

// Browser singleton — safe to call multiple times (same instance returned)
let browserClient: ReturnType<typeof createClient> | null = null

export function getSupabaseBrowserClient() {
  if (!browserClient) {
    browserClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  }
  return browserClient
}

// Server-side client (plain, no singleton — each call gets a fresh instance)
export function getSupabaseServerClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
  )
}

// ── Database types from Section 8 schema ──────────────────────────────────────

export interface Session {
  id: string
  channel_id: string
  payee: string
  payer: string
  cumulative_amount: number
  last_signature: string | null
  status: 'open' | 'closing' | 'closed'
  channel_contract: string
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
