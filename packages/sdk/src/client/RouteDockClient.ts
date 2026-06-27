import { Keypair } from '@stellar/stellar-sdk'
import { fetchManifest, selectMode, type ModeSelectOptions } from './ModeRouter.js'
import { X402Client } from './x402Client.js'
import { MppChargeClient } from './MppChargeClient.js'
import { MppSessionClient } from './MppSessionClient.js'
import type {
  PaymentMode,
  PaymentResult,
  PreflightComplianceFlags,
  PreflightResult,
  RouteDockManifest,
  SessionHandle,
} from '../types.js'
import { RouteDockManifestError, RouteDockPolicyRejectError } from '../errors.js'
import type { RetryPolicy } from '../internal/retry.js'

export interface SpendCap {
  /** Maximum total USDC spend per day (decimal string, e.g. "1.00") */
  daily: string
  asset: 'USDC'
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
}

interface ResolvedPreflight {
  manifest: RouteDockManifest
  result: PreflightResult
}

export class RouteDockClient {
  private readonly keypair: Keypair
  private readonly network: 'testnet' | 'mainnet'
  private readonly spendCap: SpendCap | undefined
  private readonly commitmentSecret: string | undefined
  private readonly retryPolicy: RetryPolicy | undefined

  /** Local daily accumulator keyed by YYYY-MM-DD */
  private dailySpend: { date: string; total: number } = { date: '', total: 0 }

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
    const { manifest, result: preflight } = await this._resolvePreflight(url, options)
    const mode = preflight.selectedMode

    this._assertNetworkMatch(preflight)
    this._assertAssetMatch(preflight)

    let result: PaymentResult

    switch (mode) {
      case 'x402':
        this._checkSpendAllowed(manifest.pricing.x402?.amount)
        result = await this.x402.pay(url, manifest)
        break
      case 'mpp-charge':
        this._checkSpendAllowed(manifest.pricing['mpp-charge']?.amount)
        result = await this.charge.pay(url, manifest)
        break
      case 'mpp-session':
        throw new RouteDockManifestError(
          'Use client.openSession() for mpp-session mode — client.pay() only handles discrete payments',
        )
      default:
        throw new RouteDockManifestError(`Unknown payment mode: ${mode as string}`)
    }

    this._recordSpend(result.amount)
    return result
  }

  /**
   * Fetch and validate the provider manifest for `url` without executing a payment.
   * Returns supported modes, estimated costs, and compatibility flags for the client.
   */
  async preflight(url: string, options?: ModeSelectOptions): Promise<PreflightResult> {
    const { result } = await this._resolvePreflight(url, options)
    return result
  }

  /**
   * Open a sustained MPP session at `url`. Verifies mpp-session is supported
   * before opening a channel. Returns a SessionHandle for streaming + closing.
   */
  async openSession(url: string): Promise<SessionHandle> {
    const { manifest, result: preflight } = await this._resolvePreflight(url, {
      forceMode: 'mpp-session',
    })

    this._assertNetworkMatch(preflight)

    if (!preflight.compliance.sessionReady || !this.commitmentSecret) {
      throw new RouteDockManifestError(
        'commitmentSecret is required in RouteDockClientConfig for mpp-session mode',
      )
    }

    return this.session.openSession(url, manifest, this.commitmentSecret)
  }

  private async _resolvePreflight(
    url: string,
    options: ModeSelectOptions = {},
  ): Promise<ResolvedPreflight> {
    const baseUrl = new URL(url).origin
    const manifest = await fetchManifest(baseUrl, this.retryPolicy)
    const selectedMode = selectMode(manifest, options)
    const compliance = this._buildComplianceFlags(manifest, selectedMode)

    return {
      manifest,
      result: {
        url,
        baseUrl,
        manifest,
        supportedModes: [...manifest.modes],
        selectedMode,
        estimatedCosts: { ...manifest.pricing },
        compliance,
      },
    }
  }

  private _buildComplianceFlags(
    manifest: RouteDockManifest,
    selectedMode: PaymentMode,
  ): PreflightComplianceFlags {
    const spendCapConfigured = this.spendCap !== undefined
    const assetMatch = !this.spendCap || manifest.asset === this.spendCap.asset
    const spendCapCoversSelectedMode = this._canAffordEstimatedSpend(
      this._getEstimatedSpendForMode(manifest, selectedMode),
    )
    const networkMatch = manifest.network === this.network
    const sessionReady = !manifest.modes.includes('mpp-session') || Boolean(this.commitmentSecret)
    const payable =
      selectedMode !== 'mpp-session' &&
      networkMatch &&
      assetMatch &&
      spendCapCoversSelectedMode

    return {
      networkMatch,
      assetMatch,
      spendCapConfigured,
      spendCapCoversSelectedMode,
      payable,
      sessionReady,
    }
  }

  private _getEstimatedSpendForMode(
    manifest: RouteDockManifest,
    mode: PaymentMode,
  ): string | undefined {
    switch (mode) {
      case 'x402':
        return manifest.pricing.x402?.amount
      case 'mpp-charge':
        return manifest.pricing['mpp-charge']?.amount
      case 'mpp-session':
        return manifest.pricing['mpp-session']?.min_deposit
      default:
        return undefined
    }
  }

  private _assertNetworkMatch(preflight: PreflightResult): void {
    if (!preflight.compliance.networkMatch) {
      throw new RouteDockManifestError(
        `Provider network ${preflight.manifest.network} does not match client network ${this.network}`,
      )
    }
  }

  private _assertAssetMatch(preflight: PreflightResult): void {
    if (!preflight.compliance.assetMatch) {
      throw new RouteDockManifestError(
        `Provider asset ${preflight.manifest.asset} does not match local spend cap asset ${this.spendCap?.asset}`,
      )
    }
  }

  /** Check local daily cap before any payment client runs. Throws if cap exceeded. */
  private _checkSpendAllowed(amount: string | undefined): void {
    if (!this._canAffordEstimatedSpend(amount)) {
      throw new RouteDockPolicyRejectError('local_daily_cap_exceeded')
    }
  }

  /** Record successful spend after settlement completes. */
  private _recordSpend(amount: string): void {
    if (!this.spendCap) return

    const amountNum = parseFloat(amount)
    this._resetDailySpendIfNeeded()
    this.dailySpend.total += amountNum
  }

  private _canAffordEstimatedSpend(amount: string | undefined): boolean {
    if (!this.spendCap || !amount) return true

    this._resetDailySpendIfNeeded()
    const amountNum = parseFloat(amount)
    const capNum = parseFloat(this.spendCap.daily)
    return this.dailySpend.total + amountNum <= capNum
  }

  private _resetDailySpendIfNeeded(): void {
    const today = new Date().toISOString().slice(0, 10)
    if (this.dailySpend.date !== today) {
      this.dailySpend = { date: today, total: 0 }
    }
  }
}
