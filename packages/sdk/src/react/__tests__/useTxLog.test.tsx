import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
GlobalRegistrator.register()
import * as RTL from '@testing-library/react'
const { renderHook, act, waitFor } = RTL
import { Keypair } from '@stellar/stellar-sdk'
import { createElement, type ReactNode } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { RouteDockClient } from '../../client/RouteDockClient.js'
import { RouteDockProvider } from '../context.js'
import { useTxLog, type TxLogRow } from '../useTxLog.js'

interface FakeSupabaseOptions {
  rows?: unknown[] | null
  error?: { message: string } | null
}

function fakeSupabase(opts: FakeSupabaseOptions | unknown[]) {
  const normalized: FakeSupabaseOptions = Array.isArray(opts)
    ? { rows: opts, error: null }
    : opts
  const eqCalls: Array<[string, unknown]> = []
  let realtimeHandler: ((payload: { new: TxLogRow }) => void) | null = null

  const channel = {
    on(_type: string, _filter: unknown, cb: (payload: { new: TxLogRow }) => void) {
      realtimeHandler = cb
      return this
    },
    subscribe() { return this },
  }
  const supabase = {
    from() {
      return {
        select() { return this },
        order() { return this },
        limit() { return this },
        eq(col: string, val: unknown) {
          eqCalls.push([col, val])
          return this
        },
        then(resolve: (v: { data: unknown[] | null; error: { message: string } | null }) => void) {
          resolve({ data: normalized.rows ?? null, error: normalized.error ?? null })
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
    supabase,
    eqCalls,
    emitInsert(row: TxLogRow) {
      realtimeHandler?.({ new: row })
    },
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
    const { supabase } = fakeSupabase(rows)
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(RouteDockProvider, { client, supabase, children })

    const { result } = renderHook(() => useTxLog({ limit: 10 }), { wrapper })

    await waitFor(() => assert.equal(result.current.length, 1))
    assert.equal(result.current[0]?.tx_hash, 'h1')
  })

  it('filters initial query by channel_id when channelId is provided', async () => {
    const client = new RouteDockClient({
      wallet: Keypair.random().secret(),
      network: 'testnet',
    })
    const rows = [
      { id: '2', tx_hash: 'h2', mode: 'mpp-session', amount: '0.01', channel_id: 'C123', created_at: 'now' },
    ]
    const { supabase, eqCalls } = fakeSupabase(rows)
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(RouteDockProvider, { client, supabase, children })

    const { result } = renderHook(() => useTxLog({ channelId: 'C123' }), { wrapper })

    await waitFor(() => assert.equal(result.current.length, 1))
    assert.deepEqual(eqCalls, [['channel_id', 'C123']])
    assert.equal(result.current[0]?.channel_id, 'C123')
  })

  it('filters Realtime INSERT events by channel_id when channelId is set', async () => {
    const client = new RouteDockClient({
      wallet: Keypair.random().secret(),
      network: 'testnet',
    })
    const { supabase, emitInsert } = fakeSupabase([])
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(RouteDockProvider, { client, supabase, children })

    const { result } = renderHook(() => useTxLog({ channelId: 'C123' }), { wrapper })

    act(() => {
      emitInsert({
        id: 'ignore-other',
        tx_hash: 'h-other',
        mode: 'mpp-session',
        amount: '0.01',
        channel_id: 'C999',
        created_at: 'now',
      })
      emitInsert({
        id: 'ignore-null',
        tx_hash: 'h-null',
        mode: 'x402',
        amount: '0.001',
        channel_id: null,
        created_at: 'now',
      })
      emitInsert({
        id: 'match',
        tx_hash: 'h-match',
        mode: 'mpp-session',
        amount: '0.02',
        channel_id: 'C123',
        created_at: 'now',
      })
    })

    await waitFor(() => assert.equal(result.current.length, 1))
    assert.equal(result.current[0]?.id, 'match')
  })

  it('supports mode: mpp-session-ws without type error and filters query', async () => {
    const client = new RouteDockClient({
      wallet: Keypair.random().secret(),
      network: 'testnet',
    })
    const rows = [
      { id: '3', tx_hash: 'h3', mode: 'mpp-session-ws', amount: '0.01', channel_id: 'C123', created_at: 'now' },
    ]
    const { supabase, eqCalls } = fakeSupabase(rows)
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(RouteDockProvider, { client, supabase, children })

    const { result } = renderHook(() => useTxLog({ mode: 'mpp-session-ws' }), { wrapper })

    await waitFor(() => assert.equal(result.current.length, 1))
    assert.deepEqual(eqCalls, [['mode', 'mpp-session-ws']])
  })

  it('logs an error and returns [] when the initial query fails', async () => {
    const client = new RouteDockClient({
      wallet: Keypair.random().secret(),
      network: 'testnet',
    })
    const { supabase } = fakeSupabase({
      rows: null,
      error: { message: 'column tx_log.channel_id does not exist' },
    })
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(RouteDockProvider, { client, supabase, children })

    const errors: string[] = []
    const origError = console.error
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '))
    }

    try {
      const { result } = renderHook(() => useTxLog({ channelId: 'C123' }), { wrapper })
      await waitFor(() =>
        assert.ok(errors.some((e) => e.includes('column tx_log.channel_id does not exist'))),
      )
      assert.deepEqual(result.current, [])
    } finally {
      console.error = origError
    }
  })
})
