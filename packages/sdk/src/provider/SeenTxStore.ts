/**
 * Idempotency store for payment settlement.
 *
 * `x402Handler` and `MppChargeHandler` settle on every request carrying a
 * payment header. An agent that retries after a post-settlement network
 * timeout resends the *same* signed payment, which would settle a second time
 * and invoke `onSettled` twice — double-counting in billing.
 *
 * Before settling, a handler derives an idempotency key from the inbound
 * payment header(s) and checks this store. On a hit it replays the cached
 * settlement response and skips both the on-chain settle and `onSettled`.
 *
 * The default {@link InMemorySeenTxStore} is per-handler and per-process. For
 * multi-instance deployments, supply a shared implementation backed by Redis,
 * Supabase, etc.
 */

/** Cached outcome of a settlement, replayed on a duplicate payment. */
export interface SettlementRecord {
  /** On-chain transaction hash (or settlement reference), if known. */
  txHash: string | null
  /** Response headers to re-apply on a replay (e.g. `X-Payment-Response`). */
  headers?: Record<string, string>
}

export interface SeenTxStore {
  /** Returns the cached settlement for a key, or `undefined` if unseen. */
  get(key: string): Promise<SettlementRecord | undefined> | SettlementRecord | undefined
  /** Records the settlement outcome for a key. */
  set(key: string, record: SettlementRecord): Promise<void> | void
}

/**
 * Default in-memory {@link SeenTxStore}. Bounded by `maxEntries` with FIFO
 * eviction so a long-running process cannot grow without limit.
 */
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

/**
 * Cryptographic SHA-256 digest of `input`, returned as 64 hex chars.
 * Uses the Web Crypto API (`crypto.subtle.digest`) which is available
 * on all modern runtimes including Cloudflare Workers, Deno, Bun, and
 * Node.js — no `Buffer` or Node `crypto` module needed.
 */
async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Derive a collision-resistant idempotency key from the inbound
 * payment-bearing headers. Uses SHA-256 instead of 32-bit FNV-1a
 * (which has a 2^32 keyspace — birthday collisions become likely
 * well before the 10_000-entry default store is full).
 *
 * x402 clients send the signed payment in `payment-signature` / `x-payment`;
 * mppx clients send it in `authorization` (the `Payment` scheme). A retry
 * resends byte-identical headers, so hashing the first present one yields a
 * stable key. Returns `null` when no payment header is present (nothing to
 * dedupe — e.g. the initial 402 challenge request).
 */
export async function paymentIdempotencyKey(
  getHeader: (name: string) => string | undefined,
): Promise<string | null> {
  const material =
    getHeader('payment-signature') ??
    getHeader('x-payment') ??
    getHeader('authorization')
  if (!material) return null
  return sha256Hex(material)
}
