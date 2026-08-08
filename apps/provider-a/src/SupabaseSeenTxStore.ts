import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Cached outcome of a settlement, replayed on a duplicate payment.
 * Structurally matches the SDK's `SettlementRecord`. Declared locally so the
 * Worker bundle never imports `@routedock/routedock/provider`, which is the
 * Node-only Express entry point.
 */
export interface SettlementRecord {
  txHash: string | null
  headers?: Record<string, string>
}

export interface SeenTxStore {
  get(key: string): Promise<SettlementRecord | undefined> | SettlementRecord | undefined
  set(key: string, record: SettlementRecord): Promise<void> | void
}

/**
 * Settlement idempotency backed by Postgres.
 *
 * The in-memory default is per-isolate. Workers run many short-lived isolates,
 * so an agent retrying a timed-out request almost always lands on a different
 * one, reads an empty cache, and settles a second time. Postgres gives the
 * cross-isolate read-your-writes consistency this needs; Workers KV would not,
 * since a retry can outrun propagation and reintroduce the double settle.
 *
 * Note: two *concurrent* identical payments can still both miss and both
 * settle. That race exists with the in-memory store too and is unchanged here.
 */
export class SupabaseSeenTxStore implements SeenTxStore {
  constructor(private readonly supabase: SupabaseClient) {}

  async get(key: string): Promise<SettlementRecord | undefined> {
    const { data, error } = await this.supabase
      .from('settlements')
      .select('tx_hash, headers')
      .eq('key', key)
      .maybeSingle()

    if (error) {
      console.error('[settlements] lookup failed:', error.message)
      return undefined
    }
    if (!data) return undefined

    const headers = data.headers as Record<string, string> | null
    return {
      txHash: (data.tx_hash as string | null) ?? null,
      ...(headers ? { headers } : {}),
    }
  }

  async set(key: string, record: SettlementRecord): Promise<void> {
    const { error } = await this.supabase.from('settlements').upsert(
      {
        key,
        tx_hash: record.txHash,
        headers: record.headers ?? null,
      },
      { onConflict: 'key' },
    )

    if (error) console.error('[settlements] write failed:', error.message)
  }
}

/** Bounded per-isolate fallback used when Supabase is not configured. */
export class InMemorySeenTxStore implements SeenTxStore {
  private readonly map = new Map<string, SettlementRecord>()
  private readonly order: string[] = []

  constructor(private readonly maxEntries = 10_000) {}

  get(key: string): SettlementRecord | undefined {
    return this.map.get(key)
  }

  set(key: string, record: SettlementRecord): void {
    if (!this.map.has(key)) {
      this.order.push(key)
      if (this.order.length > this.maxEntries) {
        const evicted = this.order.shift()
        if (evicted !== undefined) this.map.delete(evicted)
      }
    }
    this.map.set(key, record)
  }
}
