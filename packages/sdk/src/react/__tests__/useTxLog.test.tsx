import { describe, it } from 'node:test'
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

function fakeSupabase(rows: unknown[]): SupabaseClient {
  const channel = {
    on() { return this },
    subscribe() { return this },
  }
  return {
    from() {
      return {
        select() { return this },
        order() { return this },
        limit() { return this },
        eq() { return this },
        then(resolve: (v: { data: unknown[] }) => void) {
          resolve({ data: rows })
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
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(RouteDockProvider, { client, supabase, children })

    const { result } = renderHook(() => useTxLog({ limit: 10 }), { wrapper })

    await waitFor(() => assert.equal(result.current.length, 1))
    assert.equal(result.current[0]?.tx_hash, 'h1')
  })
})
