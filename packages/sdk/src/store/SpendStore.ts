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

// ── Interface ──────────────────────────────────────────────────────────────────

/**
 * Durable backing store for the client's local daily spend cap.
 *
 * The spend cap is a financial safety control: if its accumulator lives only in
 * heap memory, any crash, OOM kill, or container restart silently resets it to
 * zero and the cap can be bypassed. Inject a persistent implementation
 * (Redis, SQL, Supabase, a file, …) so the counter survives restarts.
 */
export interface SpendStore {
  /** Return the persisted accumulator, or null if none has been written yet. */
  read(): Promise<DailySpend | null>
  /** Persist the accumulator. */
  write(state: DailySpend): Promise<void>
}

// ── In-memory implementation (default) ──────────────────────────────────────────

export interface InMemorySpendStoreOptions {
  /** Log a startup warning about non-durability. Defaults to true. */
  warn?: boolean
}

/**
 * Default, non-durable {@link SpendStore}. Holds the accumulator on the heap, so
 * it resets on every process restart. Logs a startup warning unless silenced.
 * Use this only for development; inject a persistent store in production.
 */
export class InMemorySpendStore implements SpendStore {
  private state: DailySpend | null = null

  constructor(options: InMemorySpendStoreOptions = {}) {
    if (options.warn !== false) {
      console.warn(
        '[RouteDock] Using in-memory SpendStore: the daily spend cap is NOT durable ' +
          'and resets on every process restart. Inject a persistent SpendStore via ' +
          'RouteDockClientConfig.spendStore for production safety.',
      )
    }
  }

  async read(): Promise<DailySpend | null> {
    return this.state ? { ...this.state, endpoints: { ...this.state.endpoints } } : null
  }

  async write(state: DailySpend): Promise<void> {
    this.state = { ...state, endpoints: { ...state.endpoints } }
  }
}
