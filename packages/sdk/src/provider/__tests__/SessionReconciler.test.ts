/**
 * Unit tests for the orphaned-session recovery path in SessionReconciler.
 *
 * The sessions table stores cumulative_amount as a 7-dp decimal string
 * ('0.0010000'), so the reconciler must scale it to stroops before the
 * channel close. These tests mock @stellar/mpp/channel/server and drive
 * reconcileAbandonedSessions() with a fake Supabase client.
 *
 * Run with: pnpm --filter @routedock/routedock test
 * (requires --experimental-test-module-mocks, set in the package test script)
 */

import assert from 'node:assert/strict'
import { before, after, beforeEach, describe, it, mock } from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import type { SupabaseClient } from '@supabase/supabase-js'

const payeeSecretKey = Keypair.random().secret()

let closeCalls: Array<{ channel: string; amount: bigint }> = []
let reconciler: typeof import('../SessionReconciler.js')

interface SessionRow {
  channel_id: string
  cumulative_amount: string | null
  last_signature: string | null
  settlement_tx_hash: string | null
}

function makeSupabase(rows: SessionRow[], updates: unknown[] = []): SupabaseClient {
  return {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                is() {
                  return {
                    limit: () => Promise.resolve({ data: rows, error: null }),
                  }
                },
              }
            },
          }
        },
        update(fields: unknown) {
          updates.push(fields)
          return { eq: () => Promise.resolve({ error: null }) }
        },
      }
    },
  } as unknown as SupabaseClient
}

before(async () => {
  mock.module('@stellar/mpp/channel/server', {
    namedExports: {
      close: async (args: { channel: string; amount: bigint }) => {
        closeCalls.push({ channel: args.channel, amount: args.amount })
        return 'RECOVERED_TX_HASH'
      },
    },
  })
  // Imported after the mock is registered so the reconciler's static
  // channel-server import resolves to the mock.
  reconciler = await import('../SessionReconciler.js')
})

after(() => {
  mock.restoreAll()
})

beforeEach(() => {
  closeCalls = []
})

describe('decimalToStroops', () => {
  it('scales a 7-dp decimal string to stroops', () => {
    assert.equal(reconciler.decimalToStroops('0.0010000'), 10000n)
  })

  it('handles whole numbers and short fractions', () => {
    assert.equal(reconciler.decimalToStroops('1'), 10000000n)
    assert.equal(reconciler.decimalToStroops('2.5'), 25000000n)
  })

  it('truncates beyond 7 decimal places', () => {
    assert.equal(reconciler.decimalToStroops('0.00000019'), 1n)
  })
})

describe('reconcileAbandonedSessions', () => {
  it('recovers an orphan with a decimal cumulative_amount', async () => {
    const recovered: Array<{ channelId: string; txHash: string; totalPaid: string }> = []
    const updates: unknown[] = []
    const supabase = makeSupabase(
      [
        {
          channel_id: 'CHAN_ORPHAN',
          cumulative_amount: '0.0010000',
          last_signature: 'deadbeef',
          settlement_tx_hash: null,
        },
      ],
      updates,
    )

    const stats = await reconciler.reconcileAbandonedSessions({
      supabase,
      network: 'testnet',
      payeeSecretKey,
      onRecovered: async (channelId, txHash, totalPaid) => {
        recovered.push({ channelId, txHash, totalPaid })
      },
    })

    assert.equal(stats.orphanedCount, 1)
    assert.equal(stats.recoveredCount, 1)
    assert.equal(stats.failedCount, 0)
    assert.deepEqual(stats.errors, [])
    assert.deepEqual(closeCalls, [{ channel: 'CHAN_ORPHAN', amount: 10000n }])
    assert.deepEqual(recovered, [
      { channelId: 'CHAN_ORPHAN', txHash: 'RECOVERED_TX_HASH', totalPaid: '0.0010000' },
    ])
    assert.equal(updates.length, 1)
  })

  it('skips rows with missing fields without broadcasting', async () => {
    const supabase = makeSupabase([
      {
        channel_id: 'CHAN_NO_SIG',
        cumulative_amount: '0.0010000',
        last_signature: null,
        settlement_tx_hash: null,
      },
    ])

    const stats = await reconciler.reconcileAbandonedSessions({
      supabase,
      network: 'testnet',
      payeeSecretKey,
    })

    assert.equal(stats.skippedCount, 1)
    assert.equal(stats.recoveredCount, 0)
    assert.equal(closeCalls.length, 0)
  })
})
