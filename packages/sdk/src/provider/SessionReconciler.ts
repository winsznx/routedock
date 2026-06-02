/**
 * Session Reconciler — Recovery mechanism for orphaned MPP sessions
 *
 * Scans Supabase for sessions marked as "closing" (client initiated close but
 * provider crashed before broadcasting settlement). Recovers abandoned funds by
 * broadcasting the channel close transaction with the latest signed commitment.
 *
 * Idempotent: Safe to run multiple times on the same session (settlement_tx_hash
 * acts as deduplication key).
 */

import { Keypair } from '@stellar/stellar-sdk'
import { close as channelClose } from '@stellar/mpp/channel/server'
import type { SupabaseClient } from '@supabase/supabase-js'

type Network = 'testnet' | 'mainnet'

const MPP_NETWORK: Record<Network, 'stellar:testnet' | 'stellar:pubnet'> = {
  testnet: 'stellar:testnet',
  mainnet: 'stellar:pubnet',
}

export interface SessionReconcilerOptions {
  supabase: SupabaseClient
  network: Network
  payeeSecretKey: string
  onRecovered?: (channelId: string, txHash: string, totalPaid: string) => Promise<void>
}

export interface ReconciliationStats {
  orphanedCount: number
  recoveredCount: number
  skippedCount: number
  failedCount: number
  errors: Array<{ channelId: string; reason: string }>
}

/**
 * Scan for abandoned sessions and attempt recovery.
 * Idempotent: sessions with settlement_tx_hash are skipped (already recovered).
 */
export async function reconcileAbandonedSessions(
  opts: SessionReconcilerOptions,
): Promise<ReconciliationStats> {
  const stats: ReconciliationStats = {
    orphanedCount: 0,
    recoveredCount: 0,
    skippedCount: 0,
    failedCount: 0,
    errors: [],
  }

  const payeeKeypair = Keypair.fromSecret(opts.payeeSecretKey)
  const networkId = MPP_NETWORK[opts.network]

  try {
    // Query for sessions in "closing" state with no settlement_tx_hash
    const { data: closingSessions, error } = await opts.supabase
      .from('sessions')
      .select('channel_id, cumulative_amount, last_signature, settlement_tx_hash')
      .eq('status', 'closing')
      .is('settlement_tx_hash', null)
      .limit(100)

    if (error) {
      throw new Error(`Failed to query sessions: ${error.message}`)
    }

    stats.orphanedCount = closingSessions?.length ?? 0

    if (!closingSessions || closingSessions.length === 0) {
      return stats
    }

    // Attempt to recover each session
    for (const session of closingSessions) {
      try {
        const { channel_id: channelId, cumulative_amount, last_signature } = session

        // Validate required fields
        if (!channelId || !cumulative_amount || !last_signature) {
          stats.skippedCount++
          continue
        }

        const closeAmount = BigInt(cumulative_amount)
        const closeSig = Buffer.from(last_signature, 'hex')

        // Broadcast channel close transaction
        const closeTxHash = await channelClose({
          channel: channelId,
          amount: closeAmount,
          signature: closeSig,
          feePayer: { envelopeSigner: payeeKeypair },
          network: networkId,
        })

        // Mark session as recovered
        const totalPaid = (Number(closeAmount) / 1e7).toFixed(7)
        const { error: updateError } = await opts.supabase
          .from('sessions')
          .update({
            status: 'settled',
            settlement_tx_hash: closeTxHash,
            updated_at: new Date().toISOString(),
          })
          .eq('channel_id', channelId)

        if (updateError) {
          throw new Error(`Failed to update session: ${updateError.message}`)
        }

        stats.recoveredCount++

        if (opts.onRecovered) {
          await opts.onRecovered(channelId, closeTxHash, totalPaid)
        }
      } catch (err) {
        stats.failedCount++
        stats.errors.push({
          channelId: session.channel_id,
          reason: err instanceof Error ? err.message : String(err),
        })
      }
    }

    return stats
  } catch (err) {
    throw new Error(
      `Session reconciliation failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/**
 * Run reconciliation on provider startup.
 * Logs results and recovers orphaned sessions before accepting new connections.
 */
export async function runStartupReconciliation(
  opts: SessionReconcilerOptions,
  logger?: (msg: string) => void,
): Promise<void> {
  const log = logger || console.log

  log('[SessionReconciler] Running startup reconciliation...')

  try {
    const stats = await reconcileAbandonedSessions(opts)

    if (stats.orphanedCount === 0) {
      log('[SessionReconciler] No orphaned sessions found')
      return
    }

    log(
      `[SessionReconciler] Found ${stats.orphanedCount} orphaned session(s). ` +
      `Recovered: ${stats.recoveredCount}, Skipped: ${stats.skippedCount}, Failed: ${stats.failedCount}`,
    )

    if (stats.errors.length > 0) {
      log('[SessionReconciler] Reconciliation errors:')
      for (const err of stats.errors) {
        log(`  - ${err.channelId}: ${err.reason}`)
      }
    }
  } catch (err) {
    log(`[SessionReconciler] Startup reconciliation failed: ${err instanceof Error ? err.message : String(err)}`)
    // Non-fatal: allow server to start even if reconciliation fails
  }
}
