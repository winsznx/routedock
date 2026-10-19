import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { SupabaseSeenTxStore } from '../SupabaseSeenTxStore.js'

interface MockOptions {
  queryError?: string
  upsertError?: string
  data?: {
    tx_hash: string | null
    headers: Record<string, string> | null
    created_at?: string
  } | null
  rpcData?: number | null
  rpcError?: string
}

function mockSupabase(opts: MockOptions) {
  const upserts: unknown[] = []
  const rpcCalls: Array<{ fn: string; args: unknown }> = []
  const client = {
    from(_table: string) {
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
        upsert(payload: unknown, _opts: unknown) {
          upserts.push(payload)
          return Promise.resolve({
            data: null,
            error: opts.upsertError ? { message: opts.upsertError } : null,
          })
        },
      }
    },
    rpc(fn: string, args: unknown) {
      rpcCalls.push({ fn, args })
      return Promise.resolve({
        data: opts.rpcData ?? null,
        error: opts.rpcError ? { message: opts.rpcError } : null,
      })
    },
  } as unknown as SupabaseClient
  return { client, upserts, rpcCalls }
}

describe('SupabaseSeenTxStore', () => {
  it('returns undefined when no matching key exists', async () => {
    const store = new SupabaseSeenTxStore(mockSupabase({ data: null }).client)
    const result = await store.get('nonexistent')
    assert.equal(result, undefined)
  })

  it('returns a SettlementRecord with createdAt mapped from created_at', async () => {
    const createdAt = '2026-09-01T12:00:00.000Z'
    const store = new SupabaseSeenTxStore(
      mockSupabase({
        data: {
          tx_hash: 'tx_abc123',
          headers: { 'X-Payment-Response': 'encoded-response' },
          created_at: createdAt,
        },
      }).client,
    )
    const result = await store.get('key1')
    assert.deepEqual(result, {
      txHash: 'tx_abc123',
      headers: { 'X-Payment-Response': 'encoded-response' },
      createdAt: Date.parse(createdAt),
    })
  })

  it('returns txHash as null when the row has no tx_hash', async () => {
    const store = new SupabaseSeenTxStore(
      mockSupabase({
        data: { tx_hash: null, headers: null, created_at: '2026-09-01T12:00:00.000Z' },
      }).client,
    )
    const result = await store.get('key1')
    assert.deepEqual(result, {
      txHash: null,
      createdAt: Date.parse('2026-09-01T12:00:00.000Z'),
    })
  })

  it('throws RouteDockNetworkError on query failure', async () => {
    const store = new SupabaseSeenTxStore(
      mockSupabase({ queryError: 'relation "settlements" does not exist' }).client,
    )
    await assert.rejects(() => store.get('key1'), {
      name: 'RouteDockNetworkError',
      message: /SupabaseSeenTxStore\.get failed/,
    })
  })

  it('writes created_at from the record on set', async () => {
    const createdAt = Date.UTC(2026, 8, 1, 12, 0, 0)
    const { client, upserts } = mockSupabase({})
    const store = new SupabaseSeenTxStore(client)
    await store.set('key1', { txHash: 'hash1', headers: { 'x-test': 'val' }, createdAt })

    assert.deepEqual(upserts, [
      {
        key: 'key1',
        tx_hash: 'hash1',
        headers: { 'x-test': 'val' },
        created_at: new Date(createdAt).toISOString(),
      },
    ])
  })

  it('throws RouteDockNetworkError on upsert failure', async () => {
    const store = new SupabaseSeenTxStore(mockSupabase({ upsertError: 'duplicate key value' }).client)
    await assert.rejects(
      () => store.set('key1', { txHash: 'hash1', headers: { 'x-test': 'val' }, createdAt: Date.now() }),
      {
        name: 'RouteDockNetworkError',
        message: /SupabaseSeenTxStore\.set failed/,
      },
    )
  })

  it('claimReplay calls the claim_settlement_replay RPC and returns the count', async () => {
    const { client, rpcCalls } = mockSupabase({ rpcData: 2 })
    const store = new SupabaseSeenTxStore(client)
    assert.equal(await store.claimReplay('key1'), 2)
    assert.deepEqual(rpcCalls, [
      { fn: 'claim_settlement_replay', args: { p_key: 'key1' } },
    ])
  })

  it('claimReplay returns Infinity when no row comes back', async () => {
    const store = new SupabaseSeenTxStore(mockSupabase({ rpcData: null }).client)
    assert.equal(await store.claimReplay('missing'), Number.POSITIVE_INFINITY)
  })

  it('claimReplay throws RouteDockNetworkError when the RPC errors', async () => {
    const store = new SupabaseSeenTxStore(
      mockSupabase({ rpcError: 'function claim_settlement_replay(text) does not exist' }).client,
    )
    await assert.rejects(() => store.claimReplay('key1'), {
      name: 'RouteDockNetworkError',
      message: /SupabaseSeenTxStore\.claimReplay failed/,
    })
  })
})
