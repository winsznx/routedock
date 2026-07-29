import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import {
  reconcileAbandonedSessions,
  runStartupReconciliation,
} from '../SessionReconciler.js'
import type { SessionReconcilerOptions } from '../SessionReconciler.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSupabaseMock(rows: object[] | null, updateError: object | null = null) {
  const updateFn = () => ({
    eq: () => Promise.resolve({ error: updateError }),
  })
  const selectResult = {
    eq: () => ({
      is: () => ({
        limit: () => Promise.resolve({ data: rows, error: null }),
      }),
    }),
  }
  return {
    from: (table: string) => {
      if (table === 'sessions') {
        return {
          select: () => selectResult,
          update: (_vals: object) => updateFn(),
        }
      }
      throw new Error(`Unexpected table: ${table}`)
    },
  } as unknown as SessionReconcilerOptions['supabase']
}

function makeSupabaseError() {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          is: () => ({
            limit: () => Promise.resolve({ data: null, error: { message: 'DB error' } }),
          }),
        }),
      }),
    }),
  } as unknown as SessionReconcilerOptions['supabase']
}

// Generate a valid keypair for tests — avoids hardcoding invalid secret keys
const testPayeeKeypair = Keypair.random()

const mockChannelClose = async (_args: object): Promise<string> => 'mock-tx-hash-abc'

const BASE_OPTS: SessionReconcilerOptions = {
  supabase: makeSupabaseMock([]),
  network: 'testnet',
  payeeSecretKey: testPayeeKeypair.secret(),
  channelClose: mockChannelClose,
}

// ---------------------------------------------------------------------------
// Tests: reconcileAbandonedSessions
// ---------------------------------------------------------------------------

describe('reconcileAbandonedSessions — no orphans', () => {
  it('returns zero counts when no closing sessions', async () => {
    const stats = await reconcileAbandonedSessions({
      ...BASE_OPTS,
      supabase: makeSupabaseMock([]),
    })
    assert.equal(stats.orphanedCount, 0)
    assert.equal(stats.recoveredCount, 0)
    assert.equal(stats.skippedCount, 0)
    assert.equal(stats.failedCount, 0)
    assert.deepEqual(stats.errors, [])
  })
})

describe('reconcileAbandonedSessions — happy path', () => {
  it('recovers 2 valid closing sessions', async () => {
    const sessions = [
      {
        channel_id: 'channel-aaa',
        cumulative_amount: '1000000',
        last_signature: Buffer.alloc(64).toString('hex'),
        settlement_tx_hash: null,
      },
      {
        channel_id: 'channel-bbb',
        cumulative_amount: '2000000',
        last_signature: Buffer.alloc(64).toString('hex'),
        settlement_tx_hash: null,
      },
    ]

    const closed: string[] = []
    const close = async (args: { channel: string }) => {
      closed.push(args.channel)
      return `tx-${args.channel}`
    }

    let recovered: string[] = []
    const stats = await reconcileAbandonedSessions({
      ...BASE_OPTS,
      supabase: makeSupabaseMock(sessions),
      channelClose: close as typeof mockChannelClose,
      onRecovered: async (channelId) => { recovered.push(channelId) },
    })

    assert.equal(stats.orphanedCount, 2)
    assert.equal(stats.recoveredCount, 2)
    assert.equal(stats.skippedCount, 0)
    assert.equal(stats.failedCount, 0)
    assert.deepEqual(closed.sort(), ['channel-aaa', 'channel-bbb'])
    assert.deepEqual(recovered.sort(), ['channel-aaa', 'channel-bbb'])
  })
})

describe('reconcileAbandonedSessions — incomplete fields', () => {
  it('skips session missing last_signature', async () => {
    const sessions = [
      {
        channel_id: 'channel-ccc',
        cumulative_amount: '1000000',
        last_signature: null,
        settlement_tx_hash: null,
      },
    ]
    const stats = await reconcileAbandonedSessions({
      ...BASE_OPTS,
      supabase: makeSupabaseMock(sessions),
    })
    assert.equal(stats.orphanedCount, 1)
    assert.equal(stats.skippedCount, 1)
    assert.equal(stats.recoveredCount, 0)
  })

  it('skips session missing channel_id', async () => {
    const sessions = [
      {
        channel_id: null,
        cumulative_amount: '1000000',
        last_signature: Buffer.alloc(64).toString('hex'),
        settlement_tx_hash: null,
      },
    ]
    const stats = await reconcileAbandonedSessions({
      ...BASE_OPTS,
      supabase: makeSupabaseMock(sessions),
    })
    assert.equal(stats.skippedCount, 1)
  })
})

describe('reconcileAbandonedSessions — channelClose failure', () => {
  it('records failedCount and error entry when channelClose throws', async () => {
    const sessions = [
      {
        channel_id: 'channel-ddd',
        cumulative_amount: '500000',
        last_signature: Buffer.alloc(64).toString('hex'),
        settlement_tx_hash: null,
      },
    ]
    const failingClose = async (_args: object): Promise<string> => {
      throw new Error('Horizon timeout')
    }
    const stats = await reconcileAbandonedSessions({
      ...BASE_OPTS,
      supabase: makeSupabaseMock(sessions),
      channelClose: failingClose as typeof mockChannelClose,
    })
    assert.equal(stats.failedCount, 1)
    assert.equal(stats.recoveredCount, 0)
    assert.equal(stats.errors.length, 1)
    assert.equal(stats.errors[0].channelId, 'channel-ddd')
    assert.match(stats.errors[0].reason, /Horizon timeout/)
  })
})

describe('reconcileAbandonedSessions — Supabase query error', () => {
  it('throws when Supabase query returns an error', async () => {
    await assert.rejects(
      () =>
        reconcileAbandonedSessions({
          ...BASE_OPTS,
          supabase: makeSupabaseError(),
        }),
      /Session reconciliation failed/,
    )
  })
})

// ---------------------------------------------------------------------------
// Tests: runStartupReconciliation
// ---------------------------------------------------------------------------

describe('runStartupReconciliation', () => {
  it('logs "No orphaned sessions" when no closing sessions', async () => {
    const logs: string[] = []
    await runStartupReconciliation(
      { ...BASE_OPTS, supabase: makeSupabaseMock([]) },
      (msg) => logs.push(msg),
    )
    assert.ok(logs.some((l) => l.includes('No orphaned sessions')))
  })

  it('logs recovered count when sessions exist', async () => {
    const session = {
      channel_id: 'channel-eee',
      cumulative_amount: '100000',
      last_signature: Buffer.alloc(64).toString('hex'),
      settlement_tx_hash: null,
    }
    const logs: string[] = []
    await runStartupReconciliation(
      { ...BASE_OPTS, supabase: makeSupabaseMock([session]) },
      (msg) => logs.push(msg),
    )
    assert.ok(logs.some((l) => l.includes('orphaned session')))
  })

  it('does not throw when reconciliation fails — non-fatal', async () => {
    const logs: string[] = []
    await assert.doesNotReject(
      runStartupReconciliation(
        { ...BASE_OPTS, supabase: makeSupabaseError() },
        (msg) => logs.push(msg),
      ),
    )
    assert.ok(logs.some((l) => l.includes('failed')))
  })
})
