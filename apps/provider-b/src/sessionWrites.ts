import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Mirrors the SDK's OrphanedSessionInfo. Declared locally because the type is
 * only re-exported from `@routedock/routedock/provider`, the Node-only Express
 * entry point, which must not appear in a Workers bundle.
 */
export interface OrphanedSessionInfo {
  cumulativeAmount: string
  lastSignature: string
  voucherCount: number
  reason: 'connection-closed' | 'idle-timeout'
}

export interface SessionWritersConfig {
  payee: string
  network: string
  channelContract: string
  providerUrl: string
}

export interface SessionWriters {
  onSessionOpen: (channelId: string, payer: string | null) => Promise<void>
  onVoucher: (
    channelId: string,
    voucherIndex: number,
    cumulativeAmount: string,
    signature: string,
  ) => Promise<void>
  onOrphaned: (channelId: string, info: OrphanedSessionInfo) => Promise<void>
  onSettled: (txHash: string, totalPaid: string, mode: string, payer: string | null) => Promise<void>
}

/**
 * Build the Supabase session callbacks for the provider-b Durable Object.
 *
 * `cumulative_amount` is only ever written with a `.lt` guard so a stale or
 * duplicate voucher write is a no-op, and the orphan flag is written in its own
 * UPDATE: `001_init.sql` installs a column-specific `BEFORE UPDATE OF
 * cumulative_amount` trigger that raises when the new value is not strictly
 * greater, and Postgres fires it whenever the column is in the SET list even if
 * the value is unchanged. Sending `status` and `cumulative_amount` together
 * therefore rejected the whole statement — including the status change — once
 * the last voucher had already landed, leaving the session `open` and invisible
 * to the reconciler.
 */
export function createSessionWriters(
  supabase: SupabaseClient | null,
  config: SessionWritersConfig,
): SessionWriters {
  const { payee, network, channelContract, providerUrl } = config

  return {
    onSessionOpen: async (channelId, payer) => {
      if (!supabase) return
      const { error } = await supabase.from('sessions').insert({
        channel_id: channelId,
        payee,
        payer: payer ?? 'unknown',
        cumulative_amount: '0',
        status: 'open',
        channel_contract: channelId,
        network,
        voucher_count: 0,
      })
      if (error) console.error('[supabase] session insert failed:', error.message)
    },

    onVoucher: async (channelId, voucherIndex, cumulativeAmount, signature) => {
      if (!supabase) return
      const { error } = await supabase
        .from('sessions')
        .update({
          cumulative_amount: cumulativeAmount,
          voucher_count: voucherIndex,
          last_signature: signature,
        })
        .eq('channel_id', channelId)
        .lt('cumulative_amount', cumulativeAmount)
      if (error) console.error('[supabase] voucher update failed:', error.message)
    },

    onOrphaned: async (channelId, info) => {
      if (!supabase) return

      // Flag the row first so the reconciler sees it even if the amount write
      // below fails, and never combine the two columns in one statement.
      const { error: statusError } = await supabase
        .from('sessions')
        .update({ status: 'closing' })
        .eq('channel_id', channelId)
      if (statusError) {
        console.error('[supabase] orphan status update failed:', statusError.message)
      } else {
        console.log(`[supabase] session marked closing (${info.reason}): ${channelId}`)
      }

      // Matches zero rows when the last voucher write already landed, and
      // catches the row up when it did not.
      const { error: amountError } = await supabase
        .from('sessions')
        .update({
          cumulative_amount: info.cumulativeAmount,
          last_signature: info.lastSignature || null,
          voucher_count: info.voucherCount,
        })
        .eq('channel_id', channelId)
        .lt('cumulative_amount', info.cumulativeAmount)
      if (amountError) console.error('[supabase] orphan amount update failed:', amountError.message)
    },

    onSettled: async (txHash, totalPaid, mode, payer) => {
      console.log(`[settled] mode=${mode} txHash=${txHash} totalPaid=${totalPaid}`)
      if (!supabase) return

      // `.in` so a session already flagged `closing` is closed by a clean
      // settlement; rows already `closed` stay untouched.
      const { error: closeError } = await supabase
        .from('sessions')
        .update({ status: 'closed', settlement_tx_hash: txHash })
        .eq('channel_id', channelContract)
        .in('status', ['open', 'closing'])
      if (closeError) console.error('[supabase] session close failed:', closeError.message)

      const { error } = await supabase.from('tx_log').insert({
        tx_type: 'channel_close',
        tx_hash: txHash,
        amount: parseFloat(totalPaid),
        mode,
        network,
        provider_url: providerUrl,
        agent_address: payer,
        metadata: { settled_at: new Date().toISOString() },
      })
      if (error) console.error('[supabase] tx_log insert failed:', error.message)
    },
  }
}
