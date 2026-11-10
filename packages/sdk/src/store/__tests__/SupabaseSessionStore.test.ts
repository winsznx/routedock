import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { SupabaseSessionStore } from '../SessionStore.js'
import {
  RouteDockVoucherMonotonicityError,
  RouteDockNetworkError,
} from '../../errors.js'
import type { SessionState } from '../../types.js'

function makeBaseState(overrides: Partial<SessionState> = {}): SessionState {
  return {
    channel_id: 'test-channel-1',
    payee: 'GPAYEE',
    payer: 'GPAYER',
    channel_contract: 'test-channel-contract-1',
    network: 'testnet',
    cumulative_amount: '0.0010000',
    last_signature: 'sig1',
    status: 'open',
    opened_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    settlement_tx_hash: null,
    ...overrides,
  }
}

interface FakeSupabaseOptions {
  initialRows?: Map<string, Record<string, unknown>>
  getError?: { message: string } | null
  upsertError?: { message: string } | null
  updateError?: { message: string } | null
}

function makeFakeSupabase(opts: FakeSupabaseOptions = {}) {
  const rows = opts.initialRows ?? new Map<string, Record<string, unknown>>()
  const upsertCalls: Array<{ row: Record<string, unknown>; options?: { onConflict?: string } | undefined }> = []
  const updateCalls: Array<{ payload: Record<string, unknown>; eqCol: string; eqVal: unknown }> = []

  const supabase = {
    from(table: string) {
      assert.equal(table, 'sessions')
      return {
        select(cols: string) {
          assert.equal(cols, '*')
          return {
            eq(col: string, val: string) {
              assert.equal(col, 'channel_id')
              return {
                async maybeSingle() {
                  if (opts.getError) {
                    return { data: null, error: opts.getError }
                  }
                  return { data: rows.get(val) ?? null, error: null }
                },
              }
            },
          }
        },
        async upsert(row: Record<string, unknown>, options?: { onConflict?: string }) {
          upsertCalls.push({ row, options })
          if (opts.upsertError) {
            return { data: null, error: opts.upsertError }
          }
          rows.set(String(row.channel_id), { ...row })
          return { data: row, error: null }
        },
        update(payload: Record<string, unknown>) {
          return {
            async eq(col: string, val: unknown) {
              updateCalls.push({ payload, eqCol: col, eqVal: val })
              if (opts.updateError) {
                return { data: null, error: opts.updateError }
              }
              const existing = rows.get(String(val))
              if (existing) {
                rows.set(String(val), { ...existing, ...payload })
              }
              return { data: null, error: null }
            },
          }
        },
      }
    },
  } as unknown as SupabaseClient

  return { supabase, rows, upsertCalls, updateCalls }
}

describe('SupabaseSessionStore', () => {
  it('upsert on a new channel_id inserts the row with onConflict: channel_id', async () => {
    const { supabase, upsertCalls } = makeFakeSupabase()
    const store = new SupabaseSessionStore(supabase)
    const state = makeBaseState()

    await store.upsert('test-channel-1', state)

    assert.equal(upsertCalls.length, 1)
    assert.deepEqual(upsertCalls[0]?.options, { onConflict: 'channel_id' })
    assert.equal(upsertCalls[0]?.row.channel_id, 'test-channel-1')
    assert.equal(upsertCalls[0]?.row.cumulative_amount, '0.0010000')

    const loaded = await store.get('test-channel-1')
    assert.equal(loaded?.cumulative_amount, '0.0010000')
  })

  it('upsert with a strictly higher cumulative_amount succeeds', async () => {
    const { supabase, upsertCalls } = makeFakeSupabase()
    const store = new SupabaseSessionStore(supabase)

    await store.upsert('test-channel-1', makeBaseState({ cumulative_amount: '0.0010000' }))
    await store.upsert('test-channel-1', makeBaseState({ cumulative_amount: '0.0020000' }))

    assert.equal(upsertCalls.length, 2)
    const loaded = await store.get('test-channel-1')
    assert.equal(loaded?.cumulative_amount, '0.0020000')
  })

  it('upsert with an equal cumulative_amount rejects with RouteDockVoucherMonotonicityError before calling .upsert()', async () => {
    const { supabase, upsertCalls } = makeFakeSupabase()
    const store = new SupabaseSessionStore(supabase)

    await store.upsert('test-channel-1', makeBaseState({ cumulative_amount: '0.0020000' }))
    assert.equal(upsertCalls.length, 1)

    await assert.rejects(
      () => store.upsert('test-channel-1', makeBaseState({ cumulative_amount: '0.0020000' })),
      (err: unknown) => err instanceof RouteDockVoucherMonotonicityError,
    )
    assert.equal(upsertCalls.length, 1)
  })

  it('upsert with a lower cumulative_amount rejects with RouteDockVoucherMonotonicityError before calling .upsert()', async () => {
    const { supabase, upsertCalls } = makeFakeSupabase()
    const store = new SupabaseSessionStore(supabase)

    await store.upsert('test-channel-1', makeBaseState({ cumulative_amount: '0.0020000' }))
    assert.equal(upsertCalls.length, 1)

    await assert.rejects(
      () => store.upsert('test-channel-1', makeBaseState({ cumulative_amount: '0.0010000' })),
      (err: unknown) => err instanceof RouteDockVoucherMonotonicityError,
    )
    assert.equal(upsertCalls.length, 1)
  })

  it('upsert maps a DB strictly increasing trigger error to RouteDockVoucherMonotonicityError', async () => {
    const { supabase } = makeFakeSupabase({
      upsertError: { message: 'cumulative_amount must be strictly increasing' },
    })
    const store = new SupabaseSessionStore(supabase)

    await assert.rejects(
      () => store.upsert('test-channel-1', makeBaseState()),
      (err: unknown) =>
        err instanceof RouteDockVoucherMonotonicityError &&
        err.message.includes('strictly increasing'),
    )
  })

  it('maps generic Supabase errors on get and upsert to RouteDockNetworkError', async () => {
    const getFail = makeFakeSupabase({
      getError: { message: 'connection refused' },
    })
    const storeGetFail = new SupabaseSessionStore(getFail.supabase)
    await assert.rejects(
      () => storeGetFail.get('test-channel-1'),
      (err: unknown) =>
        err instanceof RouteDockNetworkError && err.message.includes('connection refused'),
    )

    const upsertFail = makeFakeSupabase({
      upsertError: { message: 'connection refused' },
    })
    const storeUpsertFail = new SupabaseSessionStore(upsertFail.supabase)
    await assert.rejects(
      () => storeUpsertFail.upsert('test-channel-1', makeBaseState()),
      (err: unknown) =>
        err instanceof RouteDockNetworkError && err.message.includes('connection refused'),
    )
  })

  it('setStatus and close update status without including cumulative_amount in payload', async () => {
    const { supabase, updateCalls } = makeFakeSupabase()
    const store = new SupabaseSessionStore(supabase)

    await store.setStatus('ch', 'closing', 'tx123')
    await store.close('ch')

    assert.equal(updateCalls.length, 2)
    assert.equal(updateCalls[0]?.eqCol, 'channel_id')
    assert.equal(updateCalls[0]?.eqVal, 'ch')
    assert.equal(updateCalls[0]?.payload.status, 'closing')
    assert.equal(updateCalls[0]?.payload.settlement_tx_hash, 'tx123')
    assert.equal('cumulative_amount' in (updateCalls[0]?.payload ?? {}), false)

    assert.equal(updateCalls[1]?.eqCol, 'channel_id')
    assert.equal(updateCalls[1]?.eqVal, 'ch')
    assert.equal(updateCalls[1]?.payload.status, 'closed')
    assert.equal('cumulative_amount' in (updateCalls[1]?.payload ?? {}), false)
  })
})
