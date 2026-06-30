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
  /**
   * Transaction hash of the on-chain channel-open call, or null.
   * The one-way-channel contract is deployed and funded before the agent
   * runs, so openSession() performs no on-chain open and has no hash to
   * report — it returns null rather than a non-transaction identifier.
   */
  openTxHash: string | null
  /**
   * Async generator of server-sent event data.
   * Each iteration sends a voucher and yields the parsed response.
   * UNAUDITED: uses stellar-experimental/one-way-channel contract.
   */
  stream(): AsyncIterable<unknown>
  /** Close the channel on-chain with the highest signed voucher */
  close(): Promise<SessionCloseResult>
  /** Request refund from the channel contract (initiates dispute) */
  requestRefund(): Promise<string>
  /** Server-side counter-mechanism to settle with latest voucher before refund window expires */
  settleWithLatestVoucher(): Promise<string>
  /** Get the current dispute status of the channel */
  getDisputeStatus(): Promise<DisputeStatus>
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
  RouteDockNoSupportedModeError,
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
