import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { SupabaseSessionStore } from '../SessionStore.js'
import type { SessionState } from '../../types.js'
import { RouteDockVoucherMonotonicityError, RouteDockNetworkError } from '../../errors.js'

function mockSupabase(opts: {
  queryError?: string
  upsertError?: string
  updateError?: string
  data?: Record<string, unknown> | null
  onUpsert?: (payload: Record<string, unknown>, options?: unknown) => void
  onUpdate?: (payload: Record<string, unknown>, eqField?: string, eqVal?: string) => void
}): SupabaseClient {
  return {
    from(_table: string) {
      let updatePayload: Record<string, unknown> | null = null
      return {
        select(_cols: string) {
          return {
            eq(_field: string, _val: string) {
              return {
                maybeSingle() {
                  return Promise.resolve({
                    data: opts.data ?? null,
                    error: opts.queryError ? { message: opts.queryError } : null,
                  })
                },
              }
            },
          }
        },
        upsert(payload: Record<string, unknown>, options?: unknown) {
          opts.onUpsert?.(payload, options)
          return Promise.resolve({
            data: null,
            error: opts.upsertError ? { message: opts.upsertError } : null,
          })
        },
        update(payload: Record<string, unknown>) {
          updatePayload = payload
          return {
            eq(field: string, val: string) {
              opts.onUpdate?.(updatePayload!, field, val)
              return Promise.resolve({
                data: null,
                error: opts.updateError ? { message: opts.updateError } : null,
              })
            },
          }
        },
      }
    },
  } as unknown as SupabaseClient
}

const sampleRow = {
  channel_id: 'channel_123',
  payee: 'GPAYEE123',
  payer: 'GPAYER123',
  channel_contract: 'CCONTRACT123',
  network: 'testnet',
  cumulative_amount: '0.0050000',
  last_signature: 'sig_abc',
  status: 'open',
  opened_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
  settlement_tx_hash: null,
}

const sampleState: SessionState = {
  channel_id: 'channel_123',
  payee: 'GPAYEE123',
  payer: 'GPAYER123',
  channel_contract: 'CCONTRACT123',
  network: 'testnet',
  cumulative_amount: '0.0050000',
  last_signature: 'sig_abc',
  status: 'open',
  opened_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
  settlement_tx_hash: null,
}

describe('SupabaseSessionStore', () => {
  it('returns channel_contract and network from get()', async () => {
    const store = new SupabaseSessionStore(mockSupabase({ data: sampleRow }))
    const session = await store.get('channel_123')
    assert.ok(session)
    assert.equal(session.channel_contract, 'CCONTRACT123')
    assert.equal(session.network, 'testnet')
    assert.equal(session.channel_id, 'channel_123')
    assert.equal(session.payee, 'GPAYEE123')
    assert.equal(session.payer, 'GPAYER123')
  })

  it('upsert() sends non-null values for NOT NULL columns (channel_id, payee, payer, channel_contract) and network', async () => {
    const upserts: Record<string, unknown>[] = []
    const store = new SupabaseSessionStore(
      mockSupabase({
        data: null,
        onUpsert: (payload) => {
          upserts.push(payload)
        },
      }),
    )

    await store.upsert('channel_123', sampleState)

    assert.equal(upserts.length, 1)
    const payload = upserts[0]
    assert.ok(payload)
    assert.ok(payload.channel_id, 'channel_id must not be null/undefined')
    assert.ok(payload.payee, 'payee must not be null/undefined')
    assert.ok(payload.payer, 'payer must not be null/undefined')
    assert.ok(payload.channel_contract, 'channel_contract must not be null/undefined')
    assert.equal(payload.channel_contract, 'CCONTRACT123')
    assert.equal(payload.network, 'testnet')
    assert.equal(payload.channel_id, 'channel_123')
  })

  it('setStatus() calls update with a payload that has no cumulative_amount key', async () => {
    const updates: { payload: Record<string, unknown>; eqField?: string | undefined; eqVal?: string | undefined }[] = []
    const store = new SupabaseSessionStore(
      mockSupabase({
        onUpdate: (payload, eqField, eqVal) => {
          updates.push({ payload, eqField, eqVal })
        },
      }),
    )

    await store.setStatus('channel_123', 'closing')

    assert.equal(updates.length, 1)
    const update = updates[0]
    assert.ok(update)
    assert.equal('cumulative_amount' in update.payload, false)
    assert.equal(update.payload.status, 'closing')
    assert.ok(update.payload.updated_at)
    assert.equal(update.eqField, 'channel_id')
    assert.equal(update.eqVal, 'channel_123')
  })

  it('moving a stored session from open to closing at an unchanged amount resolves without throwing', async () => {
    const updates: Record<string, unknown>[] = []
    const store = new SupabaseSessionStore(
      mockSupabase({
        data: sampleRow,
        onUpdate: (payload) => {
          updates.push(payload)
        },
      }),
    )

    await assert.doesNotReject(async () => {
      await store.setStatus('channel_123', 'closing')
    })
    assert.equal(updates.length, 1)
    const payload = updates[0]
    assert.ok(payload)
    assert.equal(payload.status, 'closing')
    assert.equal('cumulative_amount' in payload, false)
  })

  it('setStatus() writes settlement_tx_hash when one is passed', async () => {
    const updates: Record<string, unknown>[] = []
    const store = new SupabaseSessionStore(
      mockSupabase({
        onUpdate: (payload) => {
          updates.push(payload)
        },
      }),
    )

    await store.setStatus('channel_123', 'closed', 'tx_settled_hash_999')

    assert.equal(updates.length, 1)
    const payload = updates[0]
    assert.ok(payload)
    assert.equal(payload.status, 'closed')
    assert.equal(payload.settlement_tx_hash, 'tx_settled_hash_999')
    assert.equal('cumulative_amount' in payload, false)
  })

  it('setStatus() rejects with RouteDockNetworkError when update fails', async () => {
    const store = new SupabaseSessionStore(
      mockSupabase({
        updateError: 'database unreachable',
      }),
    )

    await assert.rejects(
      () => store.setStatus('channel_123', 'closing'),
      RouteDockNetworkError,
    )
  })

  it('close() sends status: closed and no cumulative_amount', async () => {
    const updates: Record<string, unknown>[] = []
    const store = new SupabaseSessionStore(
      mockSupabase({
        onUpdate: (payload) => {
          updates.push(payload)
        },
      }),
    )

    await store.close('channel_123')

    assert.equal(updates.length, 1)
    const payload = updates[0]
    assert.ok(payload)
    assert.equal(payload.status, 'closed')
    assert.equal('cumulative_amount' in payload, false)
  })

  it('upsert() rejects with RouteDockVoucherMonotonicityError when cumulative_amount <= stored, without calling client upsert', async () => {
    let upsertCalled = false
    const store = new SupabaseSessionStore(
      mockSupabase({
        data: sampleRow, // cumulative_amount is 0.0050000
        onUpsert: () => {
          upsertCalled = true
        },
      }),
    )

    // Equal amount
    await assert.rejects(
      () =>
        store.upsert('channel_123', {
          ...sampleState,
          cumulative_amount: '0.0050000',
        }),
      RouteDockVoucherMonotonicityError,
    )
    assert.equal(upsertCalled, false)

    // Lower amount
    await assert.rejects(
      () =>
        store.upsert('channel_123', {
          ...sampleState,
          cumulative_amount: '0.0040000',
        }),
      RouteDockVoucherMonotonicityError,
    )
    assert.equal(upsertCalled, false)
  })
})
