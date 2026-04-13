/**
 * TypeScript types for the RouteDock manifest format.
 * Derived from packages/sdk/src/schemas/routedock.schema.json (draft-07).
 *
 * Section 5 of ROUTEDOCK_MASTER.md is the canonical specification.
 */

export type PaymentMode = 'x402' | 'mpp-charge' | 'mpp-session'

/** Per-request pricing config — used by x402 and mpp-charge modes */
export interface PricingConfig {
  /** Cost per request in the payment asset, e.g. "0.001" */
  amount: string
  per: 'request'
  /** x402 facilitator URL (OpenZeppelin Channels). Required for x402 mode. */
  facilitator?: string
}

/** Per-voucher pricing config — used by mpp-session (one-way-channel) mode */
export interface SessionPricingConfig {
  /** Cost per voucher, e.g. "0.0001" */
  rate: string
  per: 'voucher'
  /** Soroban contract address (C...) for the one-way-channel contract */
  channel_contract: string
  /** Minimum initial deposit to open a channel, e.g. "0.10" */
  min_deposit: string
  /**
   * Ledgers the server has to settle before the funder can reclaim.
   * Default: 17280 (~24h). Do NOT reduce in production — this is a
   * security parameter the server depends on to settle first.
   */
  refund_waiting_period_ledgers: number
}

/** Full RouteDock discovery manifest — served at /.well-known/routedock.json */
export interface RouteDockManifest {
  /** Schema version — always "1.0" */
  routedock: '1.0'
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
  /** Stellar address (G...) that receives payments */
  payee: string
  /** Pricing configuration per supported payment mode */
  pricing: {
    x402?: PricingConfig
    'mpp-charge'?: PricingConfig
    'mpp-session'?: SessionPricingConfig
  }
  /** Map of endpoint name to HTTP method + path, e.g. { price: "GET /price" } */
  endpoints: Record<string, string>
  /** Capability tags indexed with trigram search in the provider registry */
  tags: string[]
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

/** Result returned by session.close() */
export interface SessionCloseResult {
  /** On-chain transaction hash for the channel close */
  closeTxHash: string
  /** Total amount settled across all vouchers (decimal string) */
  totalPaid: string
  /** Number of vouchers issued during the session */
  vouchersIssued: number
}

/** Handle for a live MPP session returned by client.openSession() */
export interface SessionHandle {
  /** Stellar channel contract address (C...) */
  channelId: string
  /** Transaction hash from the channel-open on-chain call */
  openTxHash: string
  /**
   * Async generator of server-sent event data.
   * Each iteration sends a voucher and yields the parsed response.
   * UNAUDITED: uses stellar-experimental/one-way-channel contract.
   */
  stream(): AsyncIterable<unknown>
  /** Close the channel on-chain with the highest signed voucher */
  close(): Promise<SessionCloseResult>
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

// ── Error hierarchy ────────────────────────────────────────────────────────────

export class RouteDockError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RouteDockError'
  }
}

/** Manifest fetch failed, schema invalid, or required fields missing */
export class RouteDockManifestError extends RouteDockError {
  constructor(message: string) {
    super(message)
    this.name = 'RouteDockManifestError'
  }
}

/** No payment mode in the manifest is supported by this client */
export class RouteDockNoSupportedModeError extends RouteDockError {
  constructor(message: string) {
    super(message)
    this.name = 'RouteDockNoSupportedModeError'
  }
}

/** Session invariant violated (e.g. non-monotonic voucher amount) */
export class RouteDockSessionError extends RouteDockError {
  constructor(message: string) {
    super(message)
    this.name = 'RouteDockSessionError'
  }
}

/** Local spend cap or on-chain policy rejected the payment */
export class RouteDockPolicyRejectedError extends RouteDockError {
  readonly reason: string
  constructor(reason: string) {
    super(`Payment rejected by policy: ${reason}`)
    this.name = 'RouteDockPolicyRejectedError'
    this.reason = reason
  }
}
