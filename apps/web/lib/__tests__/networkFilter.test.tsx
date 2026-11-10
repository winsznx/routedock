import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface EqCall {
  table: string
  column: string
  value: unknown
}

const state = vi.hoisted(() => ({
  effects: [] as Array<() => (() => void) | void>,
  eqCalls: [] as EqCall[],
  realtimeFilter: undefined as string | undefined,
  realtimeCallback: undefined as ((payload: { new: unknown }) => void) | undefined,
  setStateCalls: [] as unknown[],
}))

function createMockSupabase() {
  return {
    from(table: string) {
      const builder = {
        select() {
          return builder
        },
        eq(column: string, value: unknown) {
          state.eqCalls.push({ table, column, value })
          return builder
        },
        not() {
          return builder
        },
        order() {
          return builder
        },
        limit() {
          return Promise.resolve({ data: [], error: null })
        },
        maybeSingle() {
          return Promise.resolve({ data: null, error: null })
        },
      }
      return builder
    },
    channel() {
      const ch = {
        on(_event: string, opts: { filter?: string }, cb: (payload: { new: unknown }) => void) {
          state.realtimeFilter = opts.filter
          state.realtimeCallback = cb
          return ch
        },
        subscribe() {
          return ch
        },
      }
      return ch
    },
    removeChannel() {
      return Promise.resolve('ok')
    },
  }
}

vi.mock('@/lib/supabase', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/supabase')>()
  return {
    ...actual,
    getSupabaseServerClient: () => createMockSupabase(),
    getSupabaseBrowserClient: () => createMockSupabase(),
  }
})

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useEffect: (fn: () => (() => void) | void) => {
      state.effects.push(fn)
    },
    useState: <T,>(initial: T): [T, (next: T | ((prev: T) => T)) => void] => [
      initial,
      (updater) => {
        const next = typeof updater === 'function' ? (updater as (prev: T) => T)(initial) : updater
        state.setStateCalls.push(next)
      },
    ],
  }
})

import DashboardPage from '@/app/(dashboard)/dashboard/page'
import { DashboardMetrics } from '@/components/dashboard/DashboardMetrics'
import { SessionTable } from '@/components/dashboard/SessionTable'
import { TxFeed } from '@/components/dashboard/TxFeed'
import { VoucherChart } from '@/components/dashboard/VoucherChart'
import { LiveFeed } from '@/components/landing/LiveFeed'

const origEnv = process.env.NEXT_PUBLIC_STELLAR_NETWORK

beforeEach(() => {
  state.effects = []
  state.eqCalls = []
  state.realtimeFilter = undefined
  state.realtimeCallback = undefined
  state.setStateCalls = []
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  if (origEnv === undefined) {
    delete process.env.NEXT_PUBLIC_STELLAR_NETWORK
  } else {
    process.env.NEXT_PUBLIC_STELLAR_NETWORK = origEnv
  }
})

describe('network filtering across dashboard and landing queries (#571)', () => {
  for (const net of ['testnet', 'mainnet'] as const) {
    it(`DashboardPage SSR filters public_sessions, tx_log, and public_dashboard_stats by ${net}`, async () => {
      process.env.NEXT_PUBLIC_STELLAR_NETWORK = net
      await DashboardPage()

      expect(state.eqCalls).toEqual([
        { table: 'public_sessions', column: 'network', value: net },
        { table: 'tx_log', column: 'network', value: net },
        { table: 'public_dashboard_stats', column: 'network', value: net },
      ])
    })

    it(`DashboardMetrics, SessionTable, VoucherChart, and LiveFeed filter by ${net}`, async () => {
      process.env.NEXT_PUBLIC_STELLAR_NETWORK = net

      renderToStaticMarkup(<DashboardMetrics initialStats={null} />)
      renderToStaticMarkup(<SessionTable initialSessions={[]} />)
      renderToStaticMarkup(<VoucherChart />)
      renderToStaticMarkup(<LiveFeed />)

      const cleanups = state.effects.map((fn) => fn())
      await vi.advanceTimersByTimeAsync(1)
      for (const cleanup of cleanups) cleanup?.()

      expect(state.eqCalls).toContainEqual({
        table: 'public_dashboard_stats',
        column: 'network',
        value: net,
      })
      expect(
        state.eqCalls.filter((c) => c.table === 'public_sessions' && c.column === 'network' && c.value === net)
          .length,
      ).toBe(2)
      expect(state.eqCalls).toContainEqual({
        table: 'tx_log',
        column: 'network',
        value: net,
      })
    })

    it(`TxFeed filters Realtime subscription by ${net} and ignores mismatched rows`, () => {
      process.env.NEXT_PUBLIC_STELLAR_NETWORK = net

      renderToStaticMarkup(<TxFeed initialEntries={[]} />)
      const cleanup = state.effects[0]?.()

      expect(state.realtimeFilter).toBe(`network=eq.${net}`)

      const otherNet = net === 'testnet' ? 'mainnet' : 'testnet'
      state.setStateCalls = []
      state.realtimeCallback?.({
        new: {
          id: 'wrong-net',
          tx_type: 'x402_settle',
          tx_hash: 'h1',
          amount: 1,
          mode: 'x402',
          network: otherNet,
          created_at: '2026-01-01T00:00:00Z',
        },
      })
      expect(state.setStateCalls).toHaveLength(0)

      state.realtimeCallback?.({
        new: {
          id: 'right-net',
          tx_type: 'x402_settle',
          tx_hash: 'h2',
          amount: 1,
          mode: 'x402',
          network: net,
          created_at: '2026-01-01T00:00:00Z',
        },
      })
      expect(state.setStateCalls).toHaveLength(1)

      cleanup?.()
    })
  }
})
