/**
 * TypeScript types for the RouteDock manifest format.
 * Derived from packages/sdk/src/schemas/routedock.schema.json (draft-07).
 *
 * Section 5 of ROUTEDOCK_MASTER.md is the canonical specification.
 */

export type PaymentMode = 'x402' | 'mpp-charge' | 'mpp-session' | 'mpp-session-ws'

/**
 * Agent custody mode — declared in routedock.json when provider accepts ZK vault payers.
 * `nulth` = Nulth proof-authorized account (the ZK-account primitive; formerly "covenant-zk").
 */
export type VaultMode = 'local-key' | 'agent-vault' | 'nulth'

/** Per-request pricing config — used by x402 and mpp-charge modes */
export interface PricingConfig {
  /** Cost per request in the payment asset, e.g. "0.001" */
  amount: string
  per: 'request'
  /** x402 facilitator URL (OpenZeppelin Channels). Required for x402 mode. */
  facilitator?: string
  /**
   * Optional per-mode payee override (Stellar G... address). When set, payments
   * for this mode are directed here instead of the top-level manifest `payee`,
   * enabling treasury separation by settlement type (e.g. x402 → facilitator
   * hot wallet, mpp-charge → direct-settlement account). Falls back to the
   * top-level `payee` when omitted.
   */
  payee?: string
}

/** Per-voucher pricing config — used by mpp-session (one-way-channel) mode */
export interface SessionPricingConfig {
  /** Cost per voucher, e.g. "0.0001" */
  rate: string
  per: 'voucher'
  /** Stable Soroban factory address (C...) used to deploy a per-session channel */
  channel_factory: string
  /** Minimum initial deposit to open a channel, e.g. "0.10" */
  min_deposit: string
  /**
   * Ledgers the server has to settle before the funder can reclaim.
   * Default: 17280 (~24h). Do NOT reduce in production — this is a
   * security parameter the server depends on to settle first.
   */
  refund_waiting_period_ledgers: number
}

/** SLA configuration */
export interface SLAConfig {
  uptime_30d_percent: number
  p95_latency_ms: number
  maintenance_windows?: {
    cron: string
    duration_minutes: number
  }[]
}

/** Endpoint descriptor */
export interface EndpointDescriptor {
  method: string
  path: string
  /** Whether this endpoint is retained only for backwards compatibility. */
  deprecated?: boolean
  /** ISO 8601 timestamp after which callers should stop using this endpoint. */
  sunset_at?: string
  headers?: Record<string, string>
  request_schema?: unknown
  response_schema?: unknown
  rate_limit?: {
    requests: number
    window_seconds: number
  }
}

/** Full RouteDock discovery manifest — served at /.well-known/routedock.json */
export interface RouteDockManifest {
  /** Manifest schema version (major.minor), e.g. "1.0", "1.1", "2.0" */
  routedock: string
  /**
   * Minimum SDK client version (major.minor) required to use this manifest.
   * Clients below this version must refuse to pay.
   */
  min_client_version?: string
  /**
   * Payment modes still listed in `modes` for backwards compatibility
   * but deprecated for new integrations.
   */
  deprecated_modes?: PaymentMode[]
  /** ISO 8601 timestamp after which this manifest version is no longer supported. */
  sunset_at?: string
  /** Human-readable provider name */
  name: string
  /** Human-readable description of the provider's data or service */
  description: string
  /** Payment modes supported by this provider */
  modes: PaymentMode[]
  /** Stellar network this provider operates on */
  network: 'testnet' | 'mainnet'
  /** Asset ticker symbol, e.g. "USDC" */
  asset: string
  /** Stellar Asset Contract (SAC) address for the payment asset */
  asset_contract: string
  /**
   * Stellar address (G...) that receives payments. Used as the default
   * recipient for all modes. Individual per-request modes (x402, mpp-charge)
   * may override this via `pricing.<mode>.payee` for treasury separation.
   * Note: mpp-session settlements always land in the server signer's account
   * (the channel pays out to the closer), so they cannot be redirected by a
   * manifest field and always use this top-level `payee` for discovery display.
   */
  payee: string
  /** Pricing configuration per supported payment mode */
  pricing: {
    x402?: PricingConfig
    'mpp-charge'?: PricingConfig
    'mpp-session'?: SessionPricingConfig
    /**
     * WebSocket transport variant of mpp-session. The channel is opened and the
     * first voucher negotiated over HTTP exactly like mpp-session, then the
     * connection upgrades to WebSocket for push-based streaming (OpenAI-style
     * inference providers). Same SessionPricingConfig shape — only the
     * streaming transport differs.
     */
    'mpp-session-ws'?: SessionPricingConfig
  }
  /** Service Level Agreement for the provider */
  sla?: SLAConfig
  /** Map of endpoint name to endpoint descriptors */
  endpoints: Record<string, EndpointDescriptor>
  /** Capability tags indexed with trigram search in the provider registry */
  tags: string[]
  /**
   * Optional vault custody mode declared by the provider.
   * When set to `nulth`, the provider accepts payers using Nulth smart accounts.
   */
  vault?: VaultMode
  /**
   * Optional Nulth smart account address (C...) that this provider is linked to.
   * Used by the client to verify the nulth_account before sending proofs.
   */
  nulth_account?: string
  /** Optional protocol features this provider supports */
  capabilities?: {
    /** Supported streaming transports */
    streaming?: ('sse' | 'websocket')[]
    /** Whether webhook callbacks are supported */
    webhooks?: boolean
    /** Whether idempotency keys are supported */
    idempotency_keys?: boolean
    /** Supported content types for request/response */
    content_types?: string[]
  }
  /**
   * IATA airport codes or UN/LOCODE identifiers for regions where this provider
   * has infrastructure (e.g. ["IAD", "AMS"]). Used by agents to select the
   * nearest provider and reduce mpp-session round-trip latency.
   */
  regions?: string[]
  /**
   * Provider-declared p50 latency in milliseconds per region code.
   * Keys must be a subset of `regions`. Agents can use these hints to
   * rank providers by expected round-trip cost before opening a session.
   * Example: { "IAD": 14, "AMS": 22 }
   */
  latency_hints?: Record<string, number>
  /**
   * Base64 Ed25519 signature of the payee keypair over the SHA-256 digest of
   * this manifest with the `signature` field omitted. Clients must verify this
   * before trusting any routing field (payee, endpoints, pricing).
   */
  signature?: string
  /** Canonical manifest-signature format. Version 2 signs nested fields recursively. */
  signature_version?: '2'
  /** Optional hierarchical categories from a published taxonomy (e.g. "data/price/crypto") */
  categories?: string[]
}

/** Result returned by client.pay() for any payment mode */
export interface PaymentResult {
  /** Parsed response body from the provider */
  data: unknown
  /** On-chain Stellar transaction hash, or null for session voucher calls */
  txHash: string | null
  /** Payment mode that was used for this call */
  mode: PaymentMode
  /** Amount paid in the payment asset (decimal string) */
  amount: string
  /** Unix timestamp (ms) when the payment completed */
  timestamp: number
}

/** Result returned by client.estimateCost() — the expected charge without submitting any transaction */
export interface EstimateCostResult {
  /** Expected charge in the payment asset (decimal string, e.g. "0.001") */
  amount: string
  /** Payment asset ticker, e.g. "USDC" */
  asset: string
  /** Payment mode that would be used */
  mode: PaymentMode
  /** Full manifest — available for approval-gate / budget-routing decisions */
  manifest: RouteDockManifest
}

/** Result returned by session.close() */
export interface SessionCloseResult {
  /** On-chain transaction hash for the channel close */
  closeTxHash: string
  /** Total amount settled across all vouchers (decimal string) */
  totalPaid: string
  /** Number of vouchers issued during the session */
  vouchersIssued: number
}

/**
 * Live session statistics returned by {@link SessionHandle.stats}.
 * Read at any point during the session — no need to close it first.
 */
export interface SessionStats {
  /** Number of vouchers issued so far in this session */
  vouchersIssued: number
  /**
   * Cumulative amount authorized across all signed vouchers so far, in
   * payment-asset decimal units (e.g. "0.0001"). Matches the units of
   * {@link SessionCloseResult.totalPaid}, so a per-session sub-cap can be
   * enforced by comparing against it mid-stream.
   */
  currentCumulative: string
  /** Stellar channel contract address (C...) */
  channelId: string
  /**
   * Transaction hash of the on-chain channel-open call, or null for a
   * pre-deployed channel (no open transaction was issued).
   */
  openTxHash: string | null
}

/** Default wall-clock lifetime of a session before it auto-closes (1h). */
export const DEFAULT_MAX_SESSION_DURATION_MS = 3_600_000

/** Options accepted by client.openSession() */
export interface SessionOptions {
  /**
   * Session payment mode. Defaults to 'mpp-session' (SSE-style one HTTP
   * request per voucher). Set to 'mpp-session-ws' to negotiate the channel
   * and first voucher over HTTP and then upgrade the connection to WebSocket
   * for push-based streaming. Requires the provider's manifest to advertise
   * the selected mode.
   */
  mode?: 'mpp-session' | 'mpp-session-ws'
  /**
   * Maximum wall-clock lifetime of the session in milliseconds. When the
   * timer fires, the session emits 'session:timeout' and auto-closes so an
   * orphaned channel cannot keep collateral locked on-chain indefinitely.
   * Defaults to {@link DEFAULT_MAX_SESSION_DURATION_MS} (1h). Pass 0 or
   * Infinity to disable the guard (not recommended).
   */
  maxDurationMs?: number
}

/** Lifecycle events emitted by a SessionHandle. */
export type SessionEvent = 'session:timeout'

/** Payload delivered with the 'session:timeout' event. */
export interface SessionTimeoutPayload {
  /** The wall-clock budget (ms) that elapsed before auto-close was triggered. */
  maxDurationMs: number
}

/**
 * Options for SessionHandle.stream().
 */
export interface StreamOptions {
  /**
   * Maximum number of voucher requests outstanding at once before backpressure
   * is applied. Default: 1 (strictly sequential — safe for all providers).
   * Increase only when the provider explicitly advertises support for concurrent
   * vouchers; out-of-order sequence numbers will cause payment failures otherwise.
   */
  concurrency?: number
}

/** Handle for a live MPP session returned by client.openSession() */
export interface SessionHandle {
  /** Stellar channel contract address (C...) */
  channelId: string
  /**
   * Transaction hash of the on-chain channel-open call, or null.
   * The one-way-channel contract is deployed and funded before the agent
   * runs, so openSession() performs no on-chain open and has no hash to
   * report — it returns null rather than a non-transaction identifier.
   */
  openTxHash: string | null
  /**
   * Async generator of streamed data.
   *
   * mpp-session: each iteration sends a voucher over HTTP and yields the
   * parsed response body. With default concurrency (1) the next voucher is not
   * issued until the provider returns HTTP 200 for the previous one.
   *
   * mpp-session-ws: opens the channel and negotiates the first voucher over
   * HTTP, upgrades the connection to WebSocket, and yields each server frame
   * (JSON frames parsed, raw strings yielded as-is). The stream ends when the
   * server closes the socket with a normal close code.
   * UNAUDITED: uses stellar-experimental/one-way-channel contract.
   */
  stream(options?: StreamOptions): AsyncIterable<unknown>
  /**
   * Snapshot of live session statistics (vouchers issued, cumulative amount
   * authorized, channel identity). Values are updated synchronously on every
   * stream() yield, so callers can log spend or enforce a per-session sub-cap
   * without terminating the session.
   */
  stats(): SessionStats
  /** Close the channel on-chain with the highest signed voucher */
  close(): Promise<SessionCloseResult>
  /** Request refund from the channel contract (initiates dispute) */
  requestRefund(): Promise<string>
  /** Server-side counter-mechanism to settle with latest voucher before refund window expires */
  settleWithLatestVoucher(): Promise<string>
  /** Get the current dispute status of the channel */
  getDisputeStatus(): Promise<DisputeStatus>
  /**
   * Subscribe to a session lifecycle event (e.g. 'session:timeout').
   * Returns an unsubscribe function.
   */
  on(event: SessionEvent, listener: (payload: SessionTimeoutPayload) => void): () => void
}

/**
 * Durable session state stored in Supabase (sessions table).
 * cumulative_amount is a decimal string to avoid float precision loss.
 * The monotonic invariant is enforced both here and at the DB level via trigger.
 */
export interface SessionState {
  channel_id: string
  payee: string
  payer: string
  /** Monotonically increasing cumulative amount — stored as string to preserve precision */
  cumulative_amount: string
  last_signature: string
  status: 'open' | 'closing' | 'closed'
  opened_at: string
  updated_at: string
  settlement_tx_hash: string | null
}

// Error types live in ./errors.js — re-exported from package entry points.
export {
  RouteDockError,
  RouteDockManifestError,
  RouteDockTrustlineError,
  RouteDockNoSupportedModeError,
  RouteDockClientVersionError,
  RouteDockFacilitatorError,
  RouteDockNetworkError,
  RouteDockSignatureError,
  RouteDockVoucherMonotonicityError,
  RouteDockPolicyRejectError,
  RouteDockChannelStateError,
  RouteDockDisputeError,
  RouteDockRefundWindowError,
  RouteDockPolicyRejectedError,
  RouteDockSessionError,
} from './errors.js'

/** Dispute status of a channel */
export type DisputeStatus = 'open' | 'in-refund-window' | 'refundable' | 'settled'
