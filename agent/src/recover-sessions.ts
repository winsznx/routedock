/**
 * RouteDock Session Recovery CLI
 *
 * Manual recovery tool for abandoned MPP sessions.
 * Scans Supabase for sessions marked as "closing" and attempts to broadcast
 * channel close transactions with the latest signed commitments.
 *
 * Usage:
 *   npx ts-node src/recover-sessions.ts
 *
 * Environment Variables:
 *   SUPABASE_URL          Supabase project URL
 *   SUPABASE_SERVICE_KEY  Supabase service role key (for admin access)
 *   STELLAR_NETWORK       Network (testnet or mainnet, default: testnet)
 *   STELLAR_PAYEE_SECRET  Payee secret key for signing settlement txs
 */

import { createClient } from '@supabase/supabase-js'
import { reconcileAbandonedSessions } from '@routedock/routedock/provider'

const SUPABASE_URL = process.env['SUPABASE_URL'] ?? ''
const SUPABASE_SERVICE_KEY = process.env['SUPABASE_SERVICE_KEY'] ?? ''
const STELLAR_NETWORK = (process.env['STELLAR_NETWORK'] ?? 'testnet') as 'testnet' | 'mainnet'
const STELLAR_PAYEE_SECRET = process.env['STELLAR_PAYEE_SECRET'] ?? ''

async function main(): Promise<void> {
  // Validation
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error(
      'FATAL: SUPABASE_URL and SUPABASE_SERVICE_KEY are required.\n' +
      'Set these environment variables to enable session recovery.',
    )
    process.exit(1)
  }

  if (!STELLAR_PAYEE_SECRET || !STELLAR_PAYEE_SECRET.startsWith('S')) {
    console.error(
      'FATAL: STELLAR_PAYEE_SECRET is required and must be a valid Stellar secret key (S...).',
    )
    process.exit(1)
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)

  console.log('[SessionRecovery] RouteDock Session Recovery Tool')
  console.log(`[SessionRecovery] Network: ${STELLAR_NETWORK}`)
  console.log(`[SessionRecovery] Supabase: ${SUPABASE_URL}`)
  console.log()

  try {
    const stats = await reconcileAbandonedSessions({
      supabase,
      network: STELLAR_NETWORK,
      payeeSecretKey: STELLAR_PAYEE_SECRET,
      onRecovered: async (channelId, txHash, totalPaid) => {
        console.log(`[SessionRecovery] Recovered: ${channelId}`)
        console.log(`  → Settled ${totalPaid} USDC`)
        console.log(`  → TxHash: ${txHash}`)
      },
    })

    console.log()
    console.log('[SessionRecovery] Recovery Summary:')
    console.log(`  Orphaned sessions found: ${stats.orphanedCount}`)
    console.log(`  Successfully recovered: ${stats.recoveredCount}`)
    console.log(`  Skipped (incomplete data): ${stats.skippedCount}`)
    console.log(`  Failed: ${stats.failedCount}`)

    if (stats.errors.length > 0) {
      console.log()
      console.log('[SessionRecovery] Errors:')
      for (const err of stats.errors) {
        console.log(`  - ${err.channelId}: ${err.reason}`)
      }
    }

    console.log()
    if (stats.recoveredCount > 0) {
      console.log('[SessionRecovery] ✓ Session recovery completed successfully')
      process.exit(0)
    } else if (stats.failedCount > 0) {
      console.log('[SessionRecovery] ✗ Session recovery completed with errors')
      process.exit(1)
    } else {
      console.log('[SessionRecovery] ✓ No orphaned sessions found')
      process.exit(0)
    }
  } catch (err) {
    console.error('[SessionRecovery] Fatal error:', err)
    process.exit(1)
  }
}

main()
