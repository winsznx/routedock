import type { SupabaseClient } from '@supabase/supabase-js'
import type { SessionState } from '../types.js'
import { RouteDockSessionError } from '../types.js'

// ── Interface ──────────────────────────────────────────────────────────────────

export interface SessionStore {
  get(channelId: string): Promise<SessionState | null>
  /** Enforce monotonic invariant at application level before writing */
  upsert(channelId: string, state: SessionState): Promise<void>
  close(channelId: string): Promise<void>
}

// ── Supabase implementation ────────────────────────────────────────────────────

export class SupabaseSessionStore implements SessionStore {
  constructor(private readonly supabase: SupabaseClient) {}

  async get(channelId: string): Promise<SessionState | null> {
    const { data, error } = await this.supabase
      .from('sessions')
      .select('*')
      .eq('channel_id', channelId)
      .maybeSingle()

    if (error) throw new RouteDockSessionError(`SessionStore.get failed: ${error.message}`)
    if (!data) return null

    return {
      channel_id: data.channel_id as string,
      payee: data.payee as string,
      payer: data.payer as string,
      cumulative_amount: String(data.cumulative_amount),
      last_signature: data.last_signature as string,
      status: data.status as SessionState['status'],
      opened_at: data.opened_at as string,
      updated_at: data.updated_at as string,
      settlement_tx_hash: data.settlement_tx_hash as string | null,
    }
  }

  async upsert(channelId: string, state: SessionState): Promise<void> {
    // Application-level monotonic invariant check — catches non-increasing
    // amounts before hitting the DB trigger, giving a typed error.
    const existing = await this.get(channelId)
    if (existing) {
      const prev = parseFloat(existing.cumulative_amount)
      const next = parseFloat(state.cumulative_amount)
      if (next <= prev) {
        throw new RouteDockSessionError(
          `cumulative_amount must be strictly increasing: ${next} <= ${prev}`,
        )
      }
    }

    const { error } = await this.supabase.from('sessions').upsert(
      {
        channel_id: state.channel_id,
        payee: state.payee,
        payer: state.payer,
        cumulative_amount: state.cumulative_amount,
        last_signature: state.last_signature,
        status: state.status,
        opened_at: state.opened_at,
        updated_at: new Date().toISOString(),
        settlement_tx_hash: state.settlement_tx_hash,
      },
      { onConflict: 'channel_id' },
    )

    if (error) {
      // DB trigger will raise 'cumulative_amount must be strictly increasing'
      if (error.message.includes('strictly increasing')) {
        throw new RouteDockSessionError(
          `cumulative_amount must be strictly increasing (DB): ${error.message}`,
        )
      }
      throw new RouteDockSessionError(`SessionStore.upsert failed: ${error.message}`)
    }
  }

  async close(channelId: string): Promise<void> {
    const { error } = await this.supabase
      .from('sessions')
      .update({ status: 'closed', updated_at: new Date().toISOString() })
      .eq('channel_id', channelId)

    if (error) throw new RouteDockSessionError(`SessionStore.close failed: ${error.message}`)
  }
}
