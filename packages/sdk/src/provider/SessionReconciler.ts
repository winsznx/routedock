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
import type { SupabaseClient } from '@supabase/supabase-js'
import { usdcToStroops } from '../internal/usdc.js'
import { hexToBytes } from '../internal/encoding.js'
import { channelAuthorizer, formatMppError } from './mppCompatibility.js'
import { resolveLogger, type RouteDockLogger } from '../internal/logger.js'

type Network = 'testnet' | 'mainnet'

const MPP_NETWORK: Record<Network, 'stellar:testnet' | 'stellar:pubnet'> = {
  testnet: 'stellar:testnet',
  mainnet: 'stellar:pubnet',
}

type ChannelCloseFn = (args: {
  channel: string
  amount: bigint
  signature: Uint8Array
  feePayer: { envelopeSigner: Keypair }
  network: 'stellar:testnet' | 'stellar:pubnet'
}) => Promise<string>

export interface SessionReconcilerOptions {
  supabase: SupabaseClient
  network: Network
  payeeSecretKey: string
  onRecovered?: (channelId: string, txHash: string, totalPaid: string) => Promise<void>
  /** Injectable for testing. Defaults to @stellar/mpp/channel/server close() */
  channelClose?: ChannelCloseFn
  /** Failed close attempts before a row is moved to the terminal `failed` status. Default 5. */
  maxReconcileAttempts?: number
}

export interface ReconciliationStats {
  orphanedCount: number
  recoveredCount: number
  skippedCount: number
  failedCount: number
  /** Rows whose channel was already closed on-chain; marked `closed` without a new close. */
  alreadyClosedCount: number
  /** Rows moved to the terminal `failed` status this run (attempt limit reached). */
  terminalCount: number
  errors: Array<{ channelId: string; reason: string }>
}

const DEFAULT_MAX_RECONCILE_ATTEMPTS = 5

/** Matches the "channel already closed" wording mapped in mppCompatibility. */
const ALREADY_CLOSED_PATTERN = /channel has been closed|channel is closed|already closed|finalized/i

export function decimalToStroops(amountStr: string): bigint {
  return usdcToStroops(amountStr)
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
    alreadyClosedCount: 0,
    terminalCount: 0,
    errors: [],
  }
  const maxAttempts = opts.maxReconcileAttempts ?? DEFAULT_MAX_RECONCILE_ATTEMPTS

  const payeeKeypair = Keypair.fromSecret(opts.payeeSecretKey)
  const networkId = MPP_NETWORK[opts.network]

  try {
    // Query for sessions in "closing" state with no settlement_tx_hash
    const { data: closingSessions, error } = await opts.supabase
      .from('sessions')
      .select('channel_id, channel_contract, cumulative_amount, last_signature, settlement_tx_hash, reconcile_attempts')
      .eq('status', 'closing')
      .eq('network', opts.network)
      .eq('payee', payeeKeypair.publicKey())
      .is('settlement_tx_hash', null)
      .not('last_signature', 'is', null)
      .order('updated_at', { ascending: true })
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
        const {
          channel_id: sessionId,
          channel_contract: channelContract,
          cumulative_amount,
          last_signature,
        } = session
        const channelId = channelContract || sessionId

        // Validate required fields
        if (!channelId || !cumulative_amount || !last_signature) {
          stats.skippedCount++
          continue
        }

        const closeAmount = decimalToStroops(cumulative_amount)
        const closeSig = hexToBytes(last_signature)

        // Broadcast channel close transaction
        const closeFn: ChannelCloseFn =
          opts.channelClose ??
          (await import('@stellar/mpp/channel/server')).close

        const closeTxHash = await closeFn({
          channel: channelId,
          amount: closeAmount,
          signature: closeSig,
          feePayer: channelAuthorizer(payeeKeypair),
          network: networkId as 'stellar:testnet' | 'stellar:pubnet',
        })

        // Mark session as recovered
        const totalPaid = (Number(closeAmount) / 1e7).toFixed(7)
        const { error: updateError } = await opts.supabase
          .from('sessions')
          .update({
            status: 'closed',
            settlement_tx_hash: closeTxHash,
            updated_at: new Date().toISOString(),
          })
          .eq('channel_id', sessionId)

        if (updateError) {
          throw new Error(`Failed to update session: ${updateError.message}`)
        }

        stats.recoveredCount++

        if (opts.onRecovered) {
          await opts.onRecovered(channelId, closeTxHash, totalPaid)
        }
      } catch (err) {
        const reason = formatMppError(err)

        // A lost status update (or a DELETE close) leaves the channel closed
        // on-chain while the row is still `closing`. Self-heal instead of
        // retrying a close that can never succeed.
        if (ALREADY_CLOSED_PATTERN.test(reason)) {
          const { error: closeError } = await opts.supabase
            .from('sessions')
            .update({
              status: 'closed',
              last_reconcile_error: `channel already closed on-chain: ${reason}`,
              updated_at: new Date().toISOString(),
            })
            .eq('channel_id', session.channel_id)

          if (!closeError) {
            stats.alreadyClosedCount++
            continue
          }
        }

        stats.failedCount++
        stats.errors.push({ channelId: session.channel_id, reason })

        // Record the failure and move the row to the back of the queue.
        const attempts = (Number(session.reconcile_attempts) || 0) + 1
        const terminal = attempts >= maxAttempts
        const { error: bookkeepingError } = await opts.supabase
          .from('sessions')
          .update({
            reconcile_attempts: attempts,
            last_reconcile_error: reason,
            updated_at: new Date().toISOString(),
            ...(terminal ? { status: 'failed' } : {}),
          })
          .eq('channel_id', session.channel_id)

        if (bookkeepingError) {
          stats.errors.push({
            channelId: session.channel_id,
            reason: `Failed to record reconcile failure: ${bookkeepingError.message}`,
          })
        } else if (terminal) {
          stats.terminalCount++
        }
      }
    }

    return stats
  } catch (err) {
    throw new Error(
      `Session reconciliation failed: ${formatMppError(err)}`,
    )
  }
}

/**
 * Run reconciliation on provider startup.
 * Logs results and recovers orphaned sessions before accepting new connections.
 */
export async function runStartupReconciliation(
  opts: SessionReconcilerOptions,
  logger?: RouteDockLogger,
): Promise<void> {
  const log = resolveLogger(logger)

  log('info', '[SessionReconciler] Running startup reconciliation...')

  try {
    const stats = await reconcileAbandonedSessions(opts)

    if (stats.orphanedCount === 0) {
      log('info', '[SessionReconciler] No orphaned sessions found')
      return
    }

    log(
      'info',
      `[SessionReconciler] Found ${stats.orphanedCount} orphaned session(s). ` +
      `Recovered: ${stats.recoveredCount}, Skipped: ${stats.skippedCount}, Failed: ${stats.failedCount}, ` +
      `Already closed: ${stats.alreadyClosedCount}, Moved to failed: ${stats.terminalCount}`,
    )

    if (stats.errors.length > 0) {
      log('warn', '[SessionReconciler] Reconciliation errors:')
      for (const err of stats.errors) {
        log('warn', `  - ${err.channelId}: ${err.reason}`)
      }
    }
  } catch (err) {
    log('error', `[SessionReconciler] Startup reconciliation failed: ${formatMppError(err)}`)
    // Non-fatal: allow server to start even if reconciliation fails
  }
}
