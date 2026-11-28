import { RouteDockPolicyRejectError } from '../errors.js'
import { resolveLogger, type RouteDockLogger } from '../internal/logger.js'

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * Daily spend accumulator, keyed by an ISO date (YYYY-MM-DD).
 *
 * Totals are decimal strings of integer microUSDC (1 USDC = 10^7 units) so
 * the record stays JSON-serializable with no floating point precision loss.
 */
export interface DailySpend {
  date: string
  /** Global accumulated spend for the day, in microUSDC (e.g. "5000000") */
  totalMicros: string
  /** Per-endpoint accumulated spend for the day, keyed by origin URL, in microUSDC */
  endpoints: Record<string, string>
}

// ── Validation ─────────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MICROS_RE = /^\d+$/

/** Policy-reject reason used when a store hands back a malformed accumulator. */
export const SPEND_STATE_INVALID = 'local_spend_state_invalid'

/**
 * Describe what is wrong with a persisted accumulator, or return `null` when it
 * is a well-formed {@link DailySpend}: an object with a `YYYY-MM-DD` date, a
 * non-negative integer string `totalMicros`, and an `endpoints` object of
 * non-negative integer strings. A missing record (`null`/`undefined`) is not
 * handled here — it is "nothing spent yet" and is the caller's call.
 */
export function describeSpendStateProblem(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return `expected an object, got ${value === null ? 'null' : Array.isArray(value) ? 'an array' : typeof value}`
  }
  const record = value as Record<string, unknown>
  if (typeof record['date'] !== 'string' || !DATE_RE.test(record['date']) || Number.isNaN(Date.parse(record['date']))) {
    return `date must be a YYYY-MM-DD string (got ${JSON.stringify(record['date'])})`
  }
  if (typeof record['totalMicros'] !== 'string' || !MICROS_RE.test(record['totalMicros'])) {
    return `totalMicros must be a non-negative integer string (got ${JSON.stringify(record['totalMicros'])})`
  }
  const endpoints = record['endpoints']
  if (typeof endpoints !== 'object' || endpoints === null || Array.isArray(endpoints)) {
    return `endpoints must be an object (got ${JSON.stringify(endpoints)})`
  }
  for (const [origin, total] of Object.entries(endpoints)) {
    if (typeof total !== 'string' || !MICROS_RE.test(total)) {
      return `endpoints["${origin}"] must be a non-negative integer string (got ${JSON.stringify(total)})`
    }
  }
  return null
}

/**
 * Validate a record read from a {@link SpendStore} and return a clean copy.
 * `null`/`undefined` mean no record exists yet (zero spend) and return `null`.
 * Anything else that is not a well-formed {@link DailySpend} throws
 * `RouteDockPolicyRejectError('local_spend_state_invalid')`: a spend cap must
 * fail closed on state it cannot trust, not reset to zero or grow its headroom.
 */
export function parseDailySpend(value: unknown): DailySpend | null {
  if (value === null || value === undefined) return null
  const problem = describeSpendStateProblem(value)
  if (problem !== null) {
    throw new RouteDockPolicyRejectError(SPEND_STATE_INVALID, {
      cause: new Error(`The persisted spend accumulator is malformed: ${problem}`),
    })
  }
  const record = value as DailySpend
  return { date: record.date, totalMicros: record.totalMicros, endpoints: { ...record.endpoints } }
}

/**
 * Identifies whose spend an accumulator belongs to. `RouteDockClient` derives it
 * from the network, the paying wallet and the cap asset, so clients that share
 * one backing store never share a cap.
 */
export type SpendScope = string

/** Build the {@link SpendScope} key `${network}:${walletPublicKey}:${asset}`. */
export function spendScopeKey(network: string, walletPublicKey: string, asset: string): SpendScope {
  return `${network}:${walletPublicKey}:${asset}`
}

// ── Interface ──────────────────────────────────────────────────────────────────

/**
 * Durable backing store for the client's local daily spend cap.
 *
 * The spend cap is a financial safety control: if its accumulator lives only in
 * heap memory, any crash, OOM kill, or container restart silently resets it to
 * zero and the cap can be bypassed. Inject a persistent implementation
 * (Redis, SQL, Supabase, a file, …) so the counter survives restarts.
 *
 * ### Malformed state
 * The client validates every record a store returns ({@link parseDailySpend}).
 * A store that returns anything other than `null` (nothing spent yet) or a
 * well-formed {@link DailySpend} makes the payment fail with
 * `RouteDockPolicyRejectError('local_spend_state_invalid')` before anything is
 * signed, and the stored state is left untouched. A custom store should
 * likewise treat a missing record as `null` and a damaged one as an error.
 *
 * ### Per-scope accounting
 * A cap bounds one wallet's spend on one network in one asset. `RouteDockClient`
 * therefore passes a {@link SpendScope} (`${network}:${walletPublicKey}:${asset}`)
 * to every call, and a store must keep a separate accumulator per scope: a
 * testnet run must not eat into a mainnet budget, and two wallets sharing one
 * file must not share one cap. The `scope` argument is optional so a custom store
 * written against the older single-accumulator shape still compiles and keeps
 * working, but it then pools every client that uses it into one cap.
 *
 * ### Sharing a store between processes
 * The client serializes its own read → check → write with an in-memory mutex,
 * but that only protects one `RouteDockClient` instance. If more than one
 * process (or client) can use the same backing store — the MCP server and the
 * E2E agent share `~/.routedock/spend.json` by default — a plain `read()` /
 * `write()` pair is a lost-update race: two writers both read total X, both
 * pass the cap check, and both write X + amount, so a payment vanishes from the
 * accumulator and the cap can be exceeded. A store that is shared across
 * processes MUST implement {@link SpendStore.update}, which the client uses
 * instead of `read()` + `write()` whenever it is present.
 */
export interface SpendStore {
  /** Return the persisted accumulator for `scope`, or null if none has been written yet. */
  read(scope?: SpendScope): Promise<DailySpend | null>
  /** Persist the accumulator for `scope`. */
  write(state: DailySpend, scope?: SpendScope): Promise<void>
  /**
   * Atomically read-modify-write the accumulator. Optional, but required for
   * stores shared across processes (see above).
   *
   * Implementations must guarantee that no other writer can change the state
   * between the read that produces `prev` and the write of `fn`'s result:
   * `fn` receives the current state (or `null`), and returns the new state to
   * persist, or `undefined` to leave the state unchanged (no write). If `fn`
   * throws, nothing is written and the error propagates. `fn` is synchronous
   * in spirit — keep it fast and free of side effects, because an
   * implementation backed by optimistic concurrency (compare-and-swap) may
   * call it more than once. Resolves to the state after the update.
   */
  update?(
    fn: (prev: DailySpend | null) => DailySpend | undefined,
    scope?: SpendScope,
  ): Promise<DailySpend | null>
}

// ── In-memory implementation (default) ──────────────────────────────────────────

/** Scope used when a caller does not pass one (single-accumulator use). */
export const DEFAULT_SCOPE: SpendScope = 'default'

export interface InMemorySpendStoreOptions {
  /** Log a startup warning about non-durability. Defaults to true. */
  warn?: boolean
  /** Log sink for the non-durability warning. Defaults to a console-backed logger. */
  logger?: RouteDockLogger
}

/**
 * Default, non-durable {@link SpendStore}. Holds the accumulator on the heap, so
 * it resets on every process restart. Logs a startup warning unless silenced.
 * Use this only for development; inject a persistent store in production.
 */
export class InMemorySpendStore implements SpendStore {
  private readonly state = new Map<SpendScope, DailySpend>()

  constructor(options: InMemorySpendStoreOptions = {}) {
    if (options.warn !== false) {
      resolveLogger(options.logger)(
        'warn',
        '[RouteDock] Using in-memory SpendStore: the daily spend cap is NOT durable ' +
          'and resets on every process restart. Inject a persistent SpendStore via ' +
          'RouteDockClientConfig.spendStore for production safety.',
      )
    }
  }

  /**
   * With no `scope`, returns the default-scope record, or the sole record when
   * exactly one scope has been written — a convenience for inspecting the store
   * of a single client. Pass a scope to read one explicitly.
   */
  async read(scope?: SpendScope): Promise<DailySpend | null> {
    const state =
      scope !== undefined
        ? this.state.get(scope)
        : (this.state.get(DEFAULT_SCOPE) ?? (this.state.size === 1 ? [...this.state.values()][0] : undefined))
    return state ? { ...state, endpoints: { ...state.endpoints } } : null
  }

  async write(state: DailySpend, scope: SpendScope = DEFAULT_SCOPE): Promise<void> {
    this.state.set(scope, { ...state, endpoints: { ...state.endpoints } })
  }
}

