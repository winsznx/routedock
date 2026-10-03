import assert from 'node:assert/strict'
import test from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { decimalToStroops, reconcileAbandonedSessions } from '../SessionReconciler.js'

type SessionRow = {
  [field: string]: unknown
  channel_id: string
  channel_contract: string | null
  cumulative_amount: string
  last_signature: string | null
  settlement_tx_hash: string | null
  network: string
  payee: string
  status: string
  updated_at: string
}

type QueryCall = { method: string; args: readonly unknown[] }

type QueryResult = { data: SessionRow[]; error: null }

type SelectQuery = {
  eq: (field: string, value: unknown) => SelectQuery
  is: (field: string, value: unknown) => SelectQuery
  not: (field: string, operator: string, value: unknown) => SelectQuery
  order: (field: string, options: { ascending: boolean }) => SelectQuery
  limit: (limit: number) => Promise<QueryResult>
}

function makeSupabaseMock(rows: SessionRow[]) {
  const store = rows.map((row) => ({ ...row }))
  const calls: QueryCall[] = []

  const supabase = {
    from: (table: string) => {
      if (table !== 'sessions') throw new Error(`unexpected table: ${table}`)

      return {
        select: () => {
          const filters: Array<(row: SessionRow) => boolean> = []
          let cap = Number.POSITIVE_INFINITY
          let orderField: string | undefined
          let ascending = true
          let query: SelectQuery

          const record = (method: string, ...args: unknown[]): void => {
            calls.push({ method, args })
          }

          query = {
            eq: (field, value) => {
              record('eq', field, value)
              filters.push((row) => row[field] === value)
              return query
            },
            is: (field, value) => {
              record('is', field, value)
              filters.push((row) => (row[field] ?? null) === value)
              return query
            },
            not: (field, operator, value) => {
              record('not', field, operator, value)
              if (operator !== 'is') throw new Error(`unsupported operator: ${operator}`)
              filters.push((row) => (row[field] ?? null) !== value)
              return query
            },
            order: (field, options) => {
              record('order', field, options)
              orderField = field
              ascending = options.ascending
              return query
            },
            limit: (limit) => {
              record('limit', limit)
              cap = limit
              const data = store.filter((row) => filters.every((filter) => filter(row)))
              if (orderField) {
                const direction = ascending ? 1 : -1
                data.sort((left, right) => {
                  const leftValue = String(left[orderField!])
                  const rightValue = String(right[orderField!])
                  return direction * leftValue.localeCompare(rightValue)
                })
              }
              return Promise.resolve({ data: data.slice(0, cap), error: null })
            },
          }
          return query
        },
        update: (data: Record<string, unknown>) => ({
          eq: async (field: string, value: unknown) => {
            calls.push({ method: 'update.eq', args: [field, value] })
            const row = store.find((candidate) => candidate[field] === value)
            if (row) Object.assign(row, data)
            return { error: null }
          },
        }),
      }
    },
  } as unknown as SupabaseClient

  return { supabase, calls, store }
}

function closingSession(
  payeeKeypair: Keypair,
  overrides: Partial<SessionRow> = {},
): SessionRow {
  return {
    channel_id: 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH',
    channel_contract: 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH',
    cumulative_amount: '0.0050000',
    last_signature: '00'.repeat(64),
    settlement_tx_hash: null,
    network: 'testnet',
    payee: payeeKeypair.publicKey(),
    status: 'closing',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

test('decimalToStroops converts decimal strings to stroops correctly', () => {
  assert.equal(decimalToStroops('5'), 50000000n)
  assert.equal(decimalToStroops('5.0'), 50000000n)
  assert.equal(decimalToStroops('0.0010000'), 10000n)
  assert.equal(decimalToStroops('0.001'), 10000n)
  assert.equal(decimalToStroops('1.5'), 15000000n)
  assert.equal(decimalToStroops('10000'), 100000000000n)
  assert.equal(decimalToStroops('0.0000001'), 1n)
  assert.throws(() => decimalToStroops('0.00000001'), /exceeds 7 decimals/)
})

test('reconcileAbandonedSessions processes a decimal string without a BigInt SyntaxError', async () => {
  const payeeKeypair = Keypair.random()
  const { supabase } = makeSupabaseMock([
    closingSession(payeeKeypair, { cumulative_amount: '0.0010000' }),
  ])

  const stats = await reconcileAbandonedSessions({
    supabase,
    network: 'testnet',
    payeeSecretKey: payeeKeypair.secret(),
    channelClose: async () => {
      throw new Error('channel close unavailable')
    },
  })

  assert.equal(stats.orphanedCount, 1)
  assert.equal(stats.errors[0]?.reason, 'channel close unavailable')
  assert.ok(!stats.errors[0]?.reason.includes('SyntaxError'))
})

test('reconcileAbandonedSessions scopes and orders the closing-session query', async () => {
  const payeeKeypair = Keypair.random()
  const { supabase, calls } = makeSupabaseMock([closingSession(payeeKeypair)])

  await reconcileAbandonedSessions({
    supabase,
    network: 'testnet',
    payeeSecretKey: payeeKeypair.secret(),
    channelClose: async () => 'tx-hash',
  })

  assert.ok(calls.some(
    (call) => call.method === 'eq' && call.args[0] === 'network' && call.args[1] === 'testnet',
  ))
  assert.ok(calls.some(
    (call) => call.method === 'eq' && call.args[0] === 'payee' && call.args[1] === payeeKeypair.publicKey(),
  ))
  assert.ok(calls.some(
    (call) => call.method === 'not'
      && call.args[0] === 'last_signature'
      && call.args[1] === 'is'
      && call.args[2] === null,
  ))

  const orderIndex = calls.findIndex(
    (call) => call.method === 'order'
      && call.args[0] === 'updated_at'
      && (call.args[1] as { ascending?: boolean } | undefined)?.ascending === true,
  )
  const limitIndex = calls.findIndex((call) => call.method === 'limit' && call.args[0] === 100)
  assert.ok(orderIndex >= 0)
  assert.ok(limitIndex > orderIndex)
})

test('reconcileAbandonedSessions never closes another network, payee, or unsigned row', async () => {
  const payeeKeypair = Keypair.random()
  const otherPayee = Keypair.random()
  const matchingChannel = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'
  const rows = [
    closingSession(payeeKeypair, { updated_at: '2026-01-04T00:00:00.000Z' }),
    closingSession(payeeKeypair, {
      channel_id: 'CWRONGNETWORK',
      network: 'mainnet',
      updated_at: '2026-01-01T00:00:00.000Z',
    }),
    closingSession(payeeKeypair, {
      channel_id: 'CWRONGPAYEE',
      payee: otherPayee.publicKey(),
      updated_at: '2026-01-02T00:00:00.000Z',
    }),
    closingSession(payeeKeypair, {
      channel_id: 'CUNSIGNED',
      last_signature: null,
      updated_at: '2026-01-03T00:00:00.000Z',
    }),
  ]
  const { supabase } = makeSupabaseMock(rows)
  const closedChannels: string[] = []

  const stats = await reconcileAbandonedSessions({
    supabase,
    network: 'testnet',
    payeeSecretKey: payeeKeypair.secret(),
    channelClose: async ({ channel }) => {
      closedChannels.push(channel)
      return 'tx-hash'
    },
  })

  assert.deepEqual(closedChannels, [matchingChannel])
  assert.equal(stats.orphanedCount, 1)
  assert.equal(stats.recoveredCount, 1)
  assert.equal(stats.failedCount, 0)
  assert.equal(stats.skippedCount, 0)
})

test('reconcileAbandonedSessions records structured close failures readably', async () => {
  const payeeKeypair = Keypair.random()
  const { supabase } = makeSupabaseMock([closingSession(payeeKeypair)])

  const stats = await reconcileAbandonedSessions({
    supabase,
    network: 'testnet',
    payeeSecretKey: payeeKeypair.secret(),
    channelClose: async () => {
      throw { code: 'scecInvalidAction', status: 'FAILED' }
    },
  })

  assert.equal(stats.errors[0]?.reason, '{"code":"scecInvalidAction","status":"FAILED"}')
})

test('reconcileAbandonedSessions recovers closing session to closed with settlement hash', async () => {
  const payeeKeypair = Keypair.random()
  const channelId = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'
  const { supabase, store } = makeSupabaseMock([closingSession(payeeKeypair)])
  let onRecoveredCalled = false

  const stats = await reconcileAbandonedSessions({
    supabase,
    network: 'testnet',
    payeeSecretKey: payeeKeypair.secret(),
    channelClose: async () => 'test_settlement_tx_hash_123',
    onRecovered: async (recoveredChannel, txHash, totalPaid) => {
      onRecoveredCalled = true
      assert.equal(recoveredChannel, channelId)
      assert.equal(txHash, 'test_settlement_tx_hash_123')
      assert.equal(totalPaid, '0.0050000')
    },
  })

  assert.equal(stats.orphanedCount, 1)
  assert.equal(stats.recoveredCount, 1)
  assert.equal(stats.failedCount, 0)
  assert.equal(stats.skippedCount, 0)
  assert.equal(store[0]?.status, 'closed')
  assert.equal(store[0]?.settlement_tx_hash, 'test_settlement_tx_hash_123')
  assert.equal(onRecoveredCalled, true)
})
