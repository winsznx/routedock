import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createSessionWriters, type SessionWritersConfig } from '../sessionWrites.js'

const CHANNEL_ID = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'

const CONFIG: SessionWritersConfig = {
  payee: 'GBRLCID5A2S6HUC4D4DSWPRWNO75CLNHS2SIPS2BPCCP55Z5N7Z36DJD',
  network: 'testnet',
  channelContract: CHANNEL_ID,
  providerUrl: 'https://api-b.routedock.xyz/stream/orderbook',
}

type Row = Record<string, unknown>

interface WriteLog {
  table: string
  payload: Record<string, unknown>
}

/**
 * Chainable, awaitable Supabase stub over an in-memory `sessions` table.
 *
 * Mirrors the parts of `001_init.sql` the writers rely on: `.eq` / `.lt` / `.in`
 * filters, and the `BEFORE UPDATE OF cumulative_amount` trigger. When an update
 * carries `cumulative_amount` and any matched row would not strictly increase,
 * the statement fails and no row is changed — exactly what the real trigger
 * does to the combined `onOrphaned` write.
 */
function makeSupabaseMock(rows: Row[]) {
  const updates: WriteLog[] = []
  const inserts: WriteLog[] = []

  function table(name: string) {
    return {
      insert(payload: Record<string, unknown>) {
        inserts.push({ table: name, payload })
        if (name === 'sessions') rows.push({ ...payload })
        return Promise.resolve({ data: null, error: null })
      },
      update(payload: Record<string, unknown>) {
        updates.push({ table: name, payload })
        const filters: Array<(row: Row) => boolean> = []
        const query = {
          eq(field: string, value: unknown) {
            filters.push((row) => row[field] === value)
            return query
          },
          lt(field: string, value: unknown) {
            filters.push((row) => Number(row[field]) < Number(value))
            return query
          },
          in(field: string, values: readonly unknown[]) {
            filters.push((row) => values.includes(row[field]))
            return query
          },
          then(
            onFulfilled: (value: { data: null; error: { message: string } | null }) => unknown,
            onRejected?: (reason: unknown) => unknown,
          ) {
            if (name !== 'sessions') {
              return Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected)
            }
            const matched = rows.filter((row) => filters.every((filter) => filter(row)))
            if (payload['cumulative_amount'] !== undefined) {
              const offending = matched.find(
                (row) => Number(payload['cumulative_amount']) <= Number(row['cumulative_amount']),
              )
              if (offending) {
                const error = {
                  message: `cumulative_amount must be strictly increasing (old=${String(offending['cumulative_amount'])}, new=${String(payload['cumulative_amount'])})`,
                }
                return Promise.resolve({ data: null, error }).then(onFulfilled, onRejected)
              }
            }
            for (const row of matched) Object.assign(row, payload)
            return Promise.resolve({ data: null, error: null }).then(onFulfilled, onRejected)
          },
        }
        return query
      },
    }
  }

  return {
    client: { from: table } as unknown as SupabaseClient,
    rows,
    updates,
    inserts,
  }
}

async function captureConsole<T>(fn: () => Promise<T>) {
  const errors: string[] = []
  const logs: string[] = []
  const originalError = console.error
  const originalLog = console.log
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '))
  }
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '))
  }
  try {
    return { result: await fn(), errors, logs }
  } finally {
    console.error = originalError
    console.log = originalLog
  }
}

describe('provider-b sessionWrites', () => {
  it('flags closing without resending an unchanged cumulative_amount', async () => {
    const { client, rows, updates } = makeSupabaseMock([])
    const writers = createSessionWriters(client, CONFIG)

    const { errors } = await captureConsole(async () => {
      await writers.onSessionOpen(CHANNEL_ID, 'GPAYER')
      await writers.onVoucher(CHANNEL_ID, 1, '0.0001000', 'aa')
      await writers.onVoucher(CHANNEL_ID, 2, '0.0002000', 'bb')
      await writers.onVoucher(CHANNEL_ID, 3, '0.0003000', 'cc')
      await writers.onOrphaned(CHANNEL_ID, {
        cumulativeAmount: '0.0003000',
        lastSignature: 'cc',
        voucherCount: 3,
        reason: 'idle-timeout',
      })
    })

    assert.equal(rows.length, 1)
    assert.equal(rows[0]!['status'], 'closing')
    assert.equal(rows[0]!['cumulative_amount'], '0.0003000')
    assert.equal(errors.some((message) => message.includes('orphan update failed')), false)

    for (const update of updates) {
      assert.ok(
        !('status' in update.payload) || !('cumulative_amount' in update.payload),
        'no update may carry status and cumulative_amount together',
      )
    }
  })

  it('catches the row up when the last voucher write never landed', async () => {
    const { client, rows } = makeSupabaseMock([])
    const writers = createSessionWriters(client, CONFIG)

    await captureConsole(async () => {
      await writers.onSessionOpen(CHANNEL_ID, 'GPAYER')
      await writers.onVoucher(CHANNEL_ID, 1, '0.0001000', 'aa')
      await writers.onOrphaned(CHANNEL_ID, {
        cumulativeAmount: '0.0003000',
        lastSignature: 'zz',
        voucherCount: 3,
        reason: 'connection-closed',
      })
    })

    assert.equal(rows[0]!['status'], 'closing')
    assert.equal(rows[0]!['cumulative_amount'], '0.0003000')
    assert.equal(rows[0]!['last_signature'], 'zz')
    assert.equal(rows[0]!['voucher_count'], 3)
  })

  it('ignores a stale or duplicate voucher amount', async () => {
    const { client, rows } = makeSupabaseMock([])
    const writers = createSessionWriters(client, CONFIG)

    const { errors } = await captureConsole(async () => {
      await writers.onSessionOpen(CHANNEL_ID, 'GPAYER')
      await writers.onVoucher(CHANNEL_ID, 1, '0.0003000', 'cc')
      await writers.onVoucher(CHANNEL_ID, 2, '0.0003000', 'dd')
    })

    assert.equal(rows[0]!['cumulative_amount'], '0.0003000')
    assert.equal(rows[0]!['voucher_count'], 1)
    assert.equal(rows[0]!['last_signature'], 'cc')
    assert.equal(errors.length, 0)
  })

  it('closes a closing row and leaves an already closed row untouched', async () => {
    const closingRow: Row = {
      channel_id: CHANNEL_ID,
      status: 'closing',
      cumulative_amount: '0.0003000',
      settlement_tx_hash: null,
    }
    const closedRow: Row = {
      channel_id: CHANNEL_ID,
      status: 'closed',
      cumulative_amount: '0.5000000',
      settlement_tx_hash: 'old-hash',
    }
    const { client, rows, inserts } = makeSupabaseMock([closingRow, closedRow])
    const writers = createSessionWriters(client, CONFIG)

    await captureConsole(async () => {
      await writers.onSettled('tx-new', '0.0003000', 'mpp-session', 'GPAYER')
    })

    assert.equal(rows[0]!['status'], 'closed')
    assert.equal(rows[0]!['settlement_tx_hash'], 'tx-new')
    assert.equal(rows[1]!['status'], 'closed')
    assert.equal(rows[1]!['settlement_tx_hash'], 'old-hash')
    assert.equal(inserts.length, 1)
    assert.equal(inserts[0]!.table, 'tx_log')
  })
})
