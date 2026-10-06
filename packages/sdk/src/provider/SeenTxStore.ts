import { resolveLogger, type RouteDockLogger } from '../internal/logger.js'

/**
 * Idempotency store for payment settlement.
 *
 * `x402Handler` and `MppChargeHandler` settle on every request carrying a
 * payment header. An agent that retries after a post-settlement network
 * timeout resends the *same* signed payment, which would settle a second time
 * and invoke `onSettled` twice — double-counting in billing.
 *
 * Before settling, a handler derives an idempotency key from the inbound
 * payment header(s) *together with the resource being paid for* and checks
 * this store. On a hit it replays the cached settlement response and skips
 * both the on-chain settle and `onSettled`. A hit older than
 * {@link SETTLEMENT_REPLAY_WINDOW_MS}, or one replayed more than
 * {@link MAX_SETTLEMENT_REPLAYS} times, is rejected instead of replayed so a
 * leaked header cannot buy unlimited requests.
 *
 * `claimReplay` and {@link SettlementRecord.createdAt} are optional so a
 * custom store written against the original two-method (`get`/`set`) contract
 * keeps compiling. See {@link checkSettlementReplay} for how a store that
 * supplies neither bounds a replay.
 *
 * The default {@link InMemorySeenTxStore} is per-handler and per-process. For
 * multi-instance deployments, supply a shared implementation backed by Redis,
 * Supabase, etc.
 */

/** The resource a settlement idempotency key is scoped to. */
export interface SettlementScope {
  /** HTTP method of the paid request (e.g. `GET`). */
  method: string
  /** Path of the paid request, without query string (e.g. `/price`). */
  path: string
  /** Charge amount as declared by the route's requirements. */
  amount: string
  /** Payee address the route settles to. */
  payTo: string
}

/** Cached outcome of a settlement, replayed on a duplicate payment. */
export interface SettlementRecord {
  /** On-chain transaction hash (or settlement reference), if known. */
  txHash: string | null
  /** Response headers to re-apply on a replay (e.g. `X-Payment-Response`). */
  headers?: Record<string, string>
  /**
   * Epoch milliseconds at which the settlement was recorded. Optional for
   * backwards compatibility with custom stores that predate the replay bound;
   * a record without it can only be bounded by the replay count.
   */
  createdAt?: number
}

export interface SeenTxStore {
  /** Returns the cached settlement for a key, or `undefined` if unseen. */
  get(key: string): Promise<SettlementRecord | undefined> | SettlementRecord | undefined
  /** Records the settlement outcome for a key. */
  set(key: string, record: SettlementRecord): Promise<void> | void
  /**
   * Optionally, atomically record one replay of `key` and return the new
   * replay count. Returns `Infinity` when the key is unknown (e.g. evicted
   * between a `get` and this call), so the caller treats the payment as spent
   * rather than replaying an unbounded number of times.
   *
   * Optional so a custom store written against the original two-method
   * (`get`/`set`) contract keeps compiling. A store that omits it is still
   * bounded by {@link SETTLEMENT_REPLAY_WINDOW_MS} when its records carry
   * {@link SettlementRecord.createdAt}.
   */
  claimReplay?(key: string): Promise<number> | number
}

export interface InMemorySeenTxStoreOptions {
  /** Maximum number of entries before FIFO eviction. Defaults to 10,000. */
  maxEntries?: number
  /** Log a startup warning about non-durability. Defaults to true. */
  warn?: boolean
  /** Log sink for the non-durability warning. Defaults to a console-backed logger. */
  logger?: RouteDockLogger
}

/**
 * How long after a settlement a byte-identical retry may still replay the
 * cached response. Matches the `maxTimeoutSeconds: 60` both x402 requirement
 * objects declare, so past this point the payment is expired anyway.
 */
export const SETTLEMENT_REPLAY_WINDOW_MS = 60_000

/**
 * How many times one settled payment may be replayed beyond the original
 * settlement. The SDK's own clients never resend a byte-identical header —
 * they re-sign on every retry — so a tight limit costs nothing while stopping
 * a leaked header from buying unlimited requests.
 */
export const MAX_SETTLEMENT_REPLAYS = 1

/** Outcome of checking whether an idempotency key may replay a settlement. */
export type SettlementReplayCheck =
  | { kind: 'miss' }
  | { kind: 'replay'; record: SettlementRecord }
  | { kind: 'spent' }

/**
 * Decide what a payment bearing `key` should do.
 *
 * - `miss`  — no cached settlement; fall through to decode and settle.
 * - `replay`— a fresh settlement within the replay window and under the replay
 *             limit; re-apply the recorded headers and skip settling.
 * - `spent` — the settlement is older than the replay window, or has already
 *             been replayed the maximum number of times; respond 402 without
 *             decoding, settling, or invoking callbacks.
 *
 * The age check runs first so an expired record never touches the replay
 * counter.
 *
 * Custom stores may predate this function and implement only `get`/`set`:
 *
 * - a record that carries `createdAt` but a store without `claimReplay` is
 *   bounded by {@link SETTLEMENT_REPLAY_WINDOW_MS} alone;
 * - a record without `createdAt` offers no window to check, so a store's own
 *   `claimReplay` is the only bound available; a store that supplies neither
 *   replays as it did before this function existed.
 */
export async function checkSettlementReplay(
  store: SeenTxStore,
  key: string,
  now = Date.now(),
): Promise<SettlementReplayCheck> {
  const record = await store.get(key)
  if (!record) return { kind: 'miss' }

  const { createdAt } = record
  if (createdAt !== undefined && now - createdAt > SETTLEMENT_REPLAY_WINDOW_MS) {
    return { kind: 'spent' }
  }

  if (store.claimReplay) {
    const replayed = await store.claimReplay(key)
    if (replayed > MAX_SETTLEMENT_REPLAYS) return { kind: 'spent' }
  }
  return { kind: 'replay', record }
}

/**
 * Default in-memory {@link SeenTxStore}. Bounded by `maxEntries` with FIFO
 * eviction so a long-running process cannot grow without limit.
 *
 * **Not durable.** On serverless/edge runtimes each request may land on a
 * fresh isolate with an empty cache, which causes duplicate settlements.
 * Supply a persistent implementation (Supabase, Redis, …) in production.
 */
export class InMemorySeenTxStore implements SeenTxStore {
  private readonly map = new Map<string, SettlementRecord>()
  private readonly replayCounts = new Map<string, number>()
  private readonly order: string[] = []

  constructor(maxEntriesOrOptions: number | InMemorySeenTxStoreOptions = 10_000) {
    const options =
      typeof maxEntriesOrOptions === 'number'
        ? { maxEntries: maxEntriesOrOptions }
        : maxEntriesOrOptions
    this.maxEntries = options.maxEntries ?? 10_000

    if (options.warn !== false) {
      const isServerless =
        typeof globalThis.navigator !== 'undefined' &&
        globalThis.navigator.userAgent === 'Cloudflare-Workers'
      if (isServerless) {
        resolveLogger(options.logger)(
          'warn',
          '[RouteDock] Using in-memory SeenTxStore: settlement deduplication is NOT durable ' +
            'and resets on every isolate restart. Supply a SupabaseSeenTxStore (or other ' +
            'durable SeenTxStore) for production safety.',
        )
      }
    }
  }

  private readonly maxEntries: number

  get(key: string): SettlementRecord | undefined {
    return this.map.get(key)
  }

  set(key: string, record: SettlementRecord): void {
    if (!this.map.has(key)) {
      this.order.push(key)
      if (this.order.length > this.maxEntries) {
        const evicted = this.order.shift()
        if (evicted !== undefined) {
          this.map.delete(evicted)
          this.replayCounts.delete(evicted)
        }
      }
    }
    this.map.set(key, record)
  }

  claimReplay(key: string): number {
    if (!this.map.has(key)) return Number.POSITIVE_INFINITY
    const next = (this.replayCounts.get(key) ?? 0) + 1
    this.replayCounts.set(key, next)
    return next
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
 * payment-bearing headers, scoped to the resource being paid for. Uses
 * SHA-256 instead of 32-bit FNV-1a (which has a 2^32 keyspace — birthday
 * collisions become likely well before the 10_000-entry default store is
 * full).
 *
 * x402 clients send the signed payment in `payment-signature` / `x-payment`;
 * mppx clients send it in `authorization` (the `Payment` scheme). A retry
 * resends byte-identical headers, so hashing the first present one yields a
 * stable key.
 *
 * The `scope` (method, path, amount, payTo) is hashed alongside the header so
 * a payment settled for one route can never replay against another route,
 * even when the same store is shared across routes. Returns `null` when no
 * payment header is present (nothing to dedupe — e.g. the initial 402
 * challenge request).
 */
export async function paymentIdempotencyKey(
  getHeader: (name: string) => string | undefined,
  scope: SettlementScope,
): Promise<string | null> {
  const material =
    getHeader('payment-signature') ??
    getHeader('x-payment') ??
    getHeader('authorization')
  if (!material) return null
  return sha256Hex(
    [scope.method, scope.path, scope.amount, scope.payTo, material].join('\n'),
  )
}
