import type { SupabaseClient } from '@supabase/supabase-js'
import type { SeenTxStore, SettlementRecord } from '../provider/SeenTxStore.js'
import { RouteDockNetworkError } from '../errors.js'

/**
 * Settlement idempotency backed by Postgres via Supabase.
 *
 * The in-memory default {@link InMemorySeenTxStore} is per-handler and
 * per-process. On serverless/edge runtimes (Cloudflare Workers, Deno Deploy,
 * Lambda@Edge) each request may land in a fresh isolate with an empty cache.
 * An agent retrying after a post-settlement timeout would miss the cache and
 * settle a second time, charging twice on-chain.
 *
 * Postgres gives the read-your-writes consistency this needs; Workers KV
 * would not, since a retry can outrun propagation and reintroduce the double
 * settle.
 *
 * Requires the `settlements` table from migration `003_settlement_idempotency`:
 *
 * ```sql
 * CREATE TABLE settlements (
 *   key        TEXT PRIMARY KEY,
 *   tx_hash    TEXT,
 *   headers    JSONB,
 *   created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 * );
 * ```
 *
 * @example
 * ```ts
 * import { SupabaseSeenTxStore } from '@routedock/routedock/provider/hono'
 * import { createClient } from '@supabase/supabase-js'
 *
 * const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!)
 * const seenTxStore = new SupabaseSeenTxStore(supabase)
 *
 * routedockHono({ ..., seenTxStore })
 * ```
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
      throw new RouteDockNetworkError(`SupabaseSeenTxStore.get failed: ${error.message}`)
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

    if (error) {
      throw new RouteDockNetworkError(`SupabaseSeenTxStore.set failed: ${error.message}`)
    }
  }
}
