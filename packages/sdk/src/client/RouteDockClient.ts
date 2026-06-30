import { Keypair } from '@stellar/stellar-sdk'
import { fetchManifest, selectMode, type ModeSelectOptions, type RouteDockLogger } from './ModeRouter.js'
import { X402Client } from './x402Client.js'
import { MppChargeClient } from './MppChargeClient.js'
import { MppSessionClient } from './MppSessionClient.js'
import type { PaymentResult, SessionHandle } from '../types.js'
import { RouteDockManifestError, RouteDockPolicyRejectError } from '../errors.js'
import type { RetryPolicy } from '../internal/retry.js'

export interface SpendCap {
  /** Maximum total USDC spend per day (decimal string, e.g. "1.00") */
  daily: string
  asset: 'USDC'
  /**
   * Optional per-endpoint daily spend caps, keyed by endpoint origin URL
   * (e.g. "https://api.openai.com"). Checked before the global `daily` cap.
   * An endpoint not listed here is only subject to the global cap.
   * Both limits are enforced independently — hitting an endpoint cap does
   * not prevent spend on other endpoints, but all spend still counts toward
   * the global cap.
   */
  endpointCaps?: Record<string, string>
}

export interface RouteDockClientConfig {
  /** Stellar keypair or raw secret key (S...) */
  wallet: Keypair | string
  network: 'testnet' | 'mainnet'
  /** Optional local daily spend cap — checked before every payment */
  spendCap?: SpendCap
  /** Ed25519 secret key (S...) for signing channel commitments. Required for mpp-session. */
  commitmentSecret?: string | undefined
  /** Retry policy for transient failures (network, facilitator 5xx). */
  retryPolicy?: RetryPolicy
  /** Structured logger for SDK events. Defaults to no-op (silent). */
  logger?: RouteDockLogger
}

export class RouteDockClient {
  private readonly keypair: Keypair
  private readonly network: 'testnet' | 'mainnet'
  private readonly spendCap: SpendCap | undefined
  private readonly commitmentSecret: string | undefined
  private readonly retryPolicy: RetryPolicy | undefined
  private readonly logger: RouteDockLogger | undefined

  /** Local daily accumulator keyed by YYYY-MM-DD */
  private dailySpend: {
    date: string
    /** Global accumulated spend for the day */
    total: number
    /** Per-endpoint accumulated spend for the day, keyed by origin URL */
    endpoints: Record<string, number>
  } = { date: '', total: 0, endpoints: {} }

  private readonly x402: X402Client
  private readonly charge: MppChargeClient
  private readonly session: MppSessionClient

  constructor(config: RouteDockClientConfig) {
    this.keypair =
      typeof config.wallet === 'string' ? Keypair.fromSecret(config.wallet) : config.wallet
    this.network = config.network
    this.spendCap = config.spendCap
    this.commitmentSecret = config.commitmentSecret
    this.retryPolicy = config.retryPolicy
    this.logger = config.logger

    const secretKey = this.keypair.secret()
    this.x402 = new X402Client(secretKey, this.network, this.retryPolicy)
    this.charge = new MppChargeClient(this.keypair, this.network, this.retryPolicy)
    this.session = new MppSessionClient(this.keypair, this.network, this.retryPolicy)
  }

  /**
   * Pay for one request at `url`. Fetches manifest, selects payment mode,
   * checks local spend cap, executes payment, returns result.
   */
  async pay(url: string, options?: ModeSelectOptions): Promise<PaymentResult> {
    const baseUrl = new URL(url).origin
    const manifest = await fetchManifest(baseUrl, this.retryPolicy)
    const mode = selectMode(manifest, { ...options, ...(this.logger && { logger: this.logger }) })

    let result: PaymentResult

    switch (mode) {
      case 'x402':
        result = await this.x402.pay(url, manifest)
        break
      case 'mpp-charge':
        result = await this.charge.pay(url, manifest)
        break
      case 'mpp-session':
        throw new RouteDockManifestError(
          'Use client.openSession() for mpp-session mode — client.pay() only handles discrete payments',
        )
      default:
        throw new RouteDockManifestError(`Unknown payment mode: ${mode as string}`)
    }

    this._checkAndRecordSpend(result.amount, new URL(url).origin)
    return result
  }

  /**
   * Open a sustained MPP session at `url`. Verifies mpp-session is supported
   * before opening a channel. Returns a SessionHandle for streaming + closing.
   */
  async openSession(url: string): Promise<SessionHandle> {
    const baseUrl = new URL(url).origin
    const manifest = await fetchManifest(baseUrl, this.retryPolicy)

    if (!manifest.modes.includes('mpp-session')) {
      throw new RouteDockManifestError(
        `Provider at ${baseUrl} does not support mpp-session mode`,
      )
    }

    if (!this.commitmentSecret) {
      throw new RouteDockManifestError(
        'commitmentSecret is required in RouteDockClientConfig for mpp-session mode',
      )
    }

    return this.session.openSession(url, manifest, this.commitmentSecret)
  }

  /**
   * Check local daily caps and record the spend. Throws if any cap is exceeded.
   *
   * Enforcement order:
   *   1. Per-endpoint cap (if `endpointCaps[endpointKey]` is set) — checked first.
   *   2. Global daily cap — checked second.
   *
   * Both limits are independent: a payment is only recorded after **both** pass.
   * All spend (regardless of endpoint) counts toward the global accumulator.
   */
  private _checkAndRecordSpend(amount: string, endpointKey: string): void {
    if (!this.spendCap) return

    const today = new Date().toISOString().slice(0, 10)
    if (this.dailySpend.date !== today) {
      this.dailySpend = { date: today, total: 0, endpoints: {} }
    }

    const amountNum = parseFloat(amount)

    // 1. Per-endpoint cap check
    const endpointCapStr = this.spendCap.endpointCaps?.[endpointKey]
    if (endpointCapStr !== undefined) {
      const endpointCapNum = parseFloat(endpointCapStr)
      const endpointTotal = this.dailySpend.endpoints[endpointKey] ?? 0
      if (endpointTotal + amountNum > endpointCapNum) {
        throw new RouteDockPolicyRejectError('local_endpoint_cap_exceeded')
      }
    }

    // 2. Global daily cap check
    const globalCapNum = parseFloat(this.spendCap.daily)
    if (this.dailySpend.total + amountNum > globalCapNum) {
      throw new RouteDockPolicyRejectError('local_daily_cap_exceeded')
    }

    // Both checks passed — record the spend
    this.dailySpend.total += amountNum
    if (endpointCapStr !== undefined) {
      this.dailySpend.endpoints[endpointKey] =
        (this.dailySpend.endpoints[endpointKey] ?? 0) + amountNum
    }
  }
}
