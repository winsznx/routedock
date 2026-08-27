import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { SupabaseSeenTxStore, InMemorySeenTxStore } from '../SupabaseSeenTxStore.js'

describe('SupabaseSeenTxStore and InMemorySeenTxStore', () => {
  it('InMemorySeenTxStore stores and retrieves records and respects maxEntries', () => {
    const store = new InMemorySeenTxStore(2)

    store.set('key1', { txHash: 'hash1' })
    store.set('key2', { txHash: 'hash2' })

    assert.deepEqual(store.get('key1'), { txHash: 'hash1' })
    assert.deepEqual(store.get('key2'), { txHash: 'hash2' })

    // Adding a 3rd key should evict key1
    store.set('key3', { txHash: 'hash3' })
    assert.equal(store.get('key1'), undefined)
    assert.deepEqual(store.get('key3'), { txHash: 'hash3' })
  })

  it('SupabaseSeenTxStore gracefully handles missing table or query errors on get', async () => {
    const mockSupabase = {
      from(_table: string) {
        return {
          select(_cols: string) {
            return {
              eq(_field: string, _val: string) {
                return {
                  maybeSingle() {
                    return Promise.resolve({
                      data: null,
                      error: { message: 'relation "settlements" does not exist' },
                    })
                  },
                }
              },
            }
          },
        }
      },
    } as unknown as SupabaseClient

    const store = new SupabaseSeenTxStore(mockSupabase)
    const result = await store.get('missing-key')

    assert.equal(result, undefined)
  })

  it('SupabaseSeenTxStore gracefully handles missing table or query errors on set', async () => {
    let upsertCalled = false
    const mockSupabase = {
      from(_table: string) {
        return {
          upsert(_payload: unknown, _opts: unknown) {
            upsertCalled = true
            return Promise.resolve({
              data: null,
              error: { message: 'relation "settlements" does not exist' },
            })
          },
        }
      },
    } as unknown as SupabaseClient

    const store = new SupabaseSeenTxStore(mockSupabase)
    await store.set('key1', { txHash: 'hash1', headers: { 'x-test': 'val' } })

    assert.equal(upsertCalled, true)
  })
})
