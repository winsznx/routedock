import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
GlobalRegistrator.register()
import * as RTL from '@testing-library/react'
const { renderHook, waitFor } = RTL
import { Keypair } from '@stellar/stellar-sdk'
import { createElement, type ReactNode } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { RouteDockClient } from '../../client/RouteDockClient.js'
import { RouteDockProvider } from '../context.js'
import { useTxLog } from '../useTxLog.js'

function fakeSupabase(rows: unknown[], error: { message: string } | null = null) {
  const queryCalls: Array<[string, string]> = []
  let realtimeHandler: ((payload: { new: unknown }) => void) | undefined
  const channel = {
    on(_event: string, _filter: unknown, handler: (payload: { new: unknown }) => void) {
      realtimeHandler = handler
      return this
    },
    subscribe() { return this },
  }
  const client = {
    from() {
      return {
        select() { return this },
        order() { return this },
        limit() { return this },
        eq(field: string, value: string) {
          queryCalls.push([field, value])
          return this
        },
        then(resolve: (v: { data: unknown[] | null; error: { message: string } | null }) => void) {
          return Promise.resolve({ data: error ? null : rows, error }).then(resolve)
        },
      } as unknown as ReturnType<SupabaseClient['from']>
    },
    channel() {
      return channel as unknown as ReturnType<SupabaseClient['channel']>
    },
    removeChannel() {
      return Promise.resolve('ok')
    },
  } as unknown as SupabaseClient

  return {
    client,
    queryCalls,
    emit(row: unknown) { realtimeHandler?.({ new: row }) },
  }
}

describe('useTxLog', () => {
  it('returns initial rows from Supabase', async () => {
    const client = new RouteDockClient({
      wallet: Keypair.random().secret(),
      network: 'testnet',
    })
    const rows = [
      { id: '1', tx_hash: 'h1', mode: 'x402', amount: '0.001', channel_id: null, created_at: 'now' },
    ]
    const supabase = fakeSupabase(rows)
    const { result } = renderHook(() => useTxLog({ limit: 10 }), { wrapper: ({ children }) =>
      createElement(RouteDockProvider, { client, supabase: supabase.client, children }) })

    await waitFor(() => assert.equal(result.current.length, 1))
    assert.equal(result.current[0]?.tx_hash, 'h1')
  })

  it('applies the channel filter to the initial query and realtime inserts', async () => {
    const client = new RouteDockClient({ wallet: Keypair.random().secret(), network: 'testnet' })
    const supabase = fakeSupabase([])
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(RouteDockProvider, { client, supabase: supabase.client, children })
    const { result } = renderHook(() => useTxLog({ channelId: 'chan_a' }), { wrapper })

    await waitFor(() => assert.deepEqual(supabase.queryCalls, [['channel_id', 'chan_a']]))
    supabase.emit({ id: 'wrong', channel_id: 'chan_b', tx_hash: 'wrong' })
    supabase.emit({ id: 'right', channel_id: 'chan_a', tx_hash: 'right' })
    await waitFor(() => assert.deepEqual(result.current.map((row) => row.id), ['right']))
  })

  it('supports the mpp-session-ws mode filter', async () => {
    const client = new RouteDockClient({ wallet: Keypair.random().secret(), network: 'testnet' })
    const supabase = fakeSupabase([])
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(RouteDockProvider, { client, supabase: supabase.client, children })
    renderHook(() => useTxLog({ mode: 'mpp-session-ws' }), { wrapper })

    await waitFor(() => assert.deepEqual(supabase.queryCalls, [['mode', 'mpp-session-ws']]))
  })

  it('logs an initial query error without throwing or replacing rows', async () => {
    const client = new RouteDockClient({ wallet: Keypair.random().secret(), network: 'testnet' })
    const supabase = fakeSupabase([], { message: 'boom' })
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(RouteDockProvider, { client, supabase: supabase.client, children })
    const error = mock.method(console, 'error')

    try {
      const { result } = renderHook(() => useTxLog(), { wrapper })
      await waitFor(() => assert.equal(error.mock.callCount(), 1))
      assert.deepEqual(result.current, [])
      assert.equal(error.mock.calls[0]?.arguments[0], '[useTxLog] initial fetch failed:')
    } finally {
      error.mock.restore()
    }
  })
})
