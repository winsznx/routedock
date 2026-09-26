import type { SupabaseClient } from '@supabase/supabase-js'
import type { SessionState } from '../types.js'
import {
  RouteDockVoucherMonotonicityError,
  RouteDockNetworkError,
} from '../errors.js'

// ── Interface ──────────────────────────────────────────────────────────────────

export interface SessionStore {
  get(channelId: string): Promise<SessionState | null>
  /** Enforce monotonic invariant at application level before writing (used for voucher amount advances) */
  upsert(channelId: string, state: SessionState): Promise<void>
  /** Update session status without altering cumulative_amount */
  setStatus(
    channelId: string,
    status: SessionState['status'],
    settlementTxHash?: string | null,
  ): Promise<void>
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

    if (error) {
      throw new RouteDockNetworkError(`SessionStore.get failed: ${error.message}`)
    }
    if (!data) return null

    return {
      channel_id: data.channel_id as string,
      payee: data.payee as string,
      payer: data.payer as string,
      channel_contract: data.channel_contract as string,
      network: data.network as SessionState['network'],
      cumulative_amount: String(data.cumulative_amount),
      last_signature: data.last_signature as string,
      status: data.status as SessionState['status'],
      opened_at: data.opened_at as string,
      updated_at: data.updated_at as string,
      settlement_tx_hash: data.settlement_tx_hash as string | null,
    }
  }

  async upsert(channelId: string, state: SessionState): Promise<void> {
    const existing = await this.get(channelId)
    if (existing) {
      const prev = parseFloat(existing.cumulative_amount)
      const next = parseFloat(state.cumulative_amount)
      if (next <= prev) {
        throw new RouteDockVoucherMonotonicityError(
          `cumulative_amount must be strictly increasing: ${next} <= ${prev}`,
        )
      }
    }

    const { error } = await this.supabase.from('sessions').upsert(
      {
        channel_id: state.channel_id,
        payee: state.payee,
        payer: state.payer,
        channel_contract: state.channel_contract,
        network: state.network,
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
      if (error.message.includes('strictly increasing')) {
        throw new RouteDockVoucherMonotonicityError(
          `cumulative_amount must be strictly increasing (DB): ${error.message}`,
        )
      }
      throw new RouteDockNetworkError(`SessionStore.upsert failed: ${error.message}`)
    }
  }

  async setStatus(
    channelId: string,
    status: SessionState['status'],
    settlementTxHash?: string | null,
  ): Promise<void> {
    const payload: Record<string, unknown> = {
      status,
      updated_at: new Date().toISOString(),
    }
    if (settlementTxHash !== undefined) {
      payload.settlement_tx_hash = settlementTxHash
    }

    const { error } = await this.supabase
      .from('sessions')
      .update(payload)
      .eq('channel_id', channelId)

    if (error) {
      throw new RouteDockNetworkError(`SessionStore.setStatus failed: ${error.message}`)
    }
  }

  async close(channelId: string): Promise<void> {
    await this.setStatus(channelId, 'closed')
  }
}
