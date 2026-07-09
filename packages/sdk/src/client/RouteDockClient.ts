import { Keypair } from '@stellar/stellar-sdk'
import { fetchManifest, selectMode, type ModeSelectOptions, type RouteDockLogger } from './ModeRouter.js'
import { X402Client } from './x402Client.js'
import { MppChargeClient } from './MppChargeClient.js'
import { MppSessionClient } from './MppSessionClient.js'
import { prepareCovenantSigner, CovenantPolicyError, type CovenantZkVaultConfig } from './CovenantZkVault.js'
import type {
  EstimateCostResult,
  PaymentMode,
  PaymentResult,
  PreflightComplianceFlags,
  PreflightResult,
  RouteDockManifest,
  SessionHandle,
  SessionOptions,
} from '../types.js'
import { RouteDockManifestError, RouteDockPolicyRejectError } from '../errors.js'
import type { RetryPolicy } from '../internal/retry.js'
import { InMemorySpendStore, type DailySpend, type SpendStore } from '../store/SpendStore.js'

// Commitment secrets are stored here instead of on the instance so they never
// appear in JSON.stringify, structured-clone, or console.log object dumps.
// The WeakMap key is the client instance, so secrets are GC-eligible once the
// instance is collected (or after dispose() is called).
const _secrets = new WeakMap<RouteDockClient, string>()

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

export type VaultConfig = CovenantZkVaultConfig

export interface RouteDockClientConfig {
  /** Stellar keypair or raw secret key (S...) — fee payer / fallback signer */
  wallet: Keypair | string
  network: 'testnet' | 'mainnet'
  /** Optional local daily spend cap — checked before every payment (local-key vault only) */
  spendCap?: SpendCap
  /**
   * Ed25519 secret key (S...) for signing channel commitments. Required for mpp-session.
   *
   * WARNING: Do not log or serialize the config object — it contains this secret in plaintext.
   * The RouteDockClient stores it outside the instance to prevent leakage via JSON.stringify
   * or console.log, but the raw config object is not protected.
   */
  commitmentSecret?: string | undefined
  /** Retry policy for transient failures (network, facilitator 5xx). */
  retryPolicy?: RetryPolicy
  /**
   * Durable backing store for the daily spend cap accumulator. Defaults to a
   * non-durable in-memory store that resets on restart (with a startup warning).
   * Inject a persistent implementation for production safety.
   */
  spendStore?: SpendStore
  /** Structured logger for SDK events. Defaults to no-op (silent). */
  logger?: RouteDockLogger
  /**
   * Timeout in milliseconds for manifest fetches. A provider that accepts the TCP
   * connection but never sends a response body will be aborted after this delay.
   * Default: 5000 ms.
   */
  manifestTimeoutMs?: number

  /**
   * Vault custody mode. When `covenant-zk`, payments use a Covenant account as payer
   * with off-chain ZK proofs attached as auth signatures.
   */
  vault?: VaultConfig
}

/**
 * Convert a decimal USDC string (e.g. "0.0001", "1.00") to an exact
 * integer count of microUSDC (1 USDC = 10^7 units on Stellar) as a bigint.
 * Avoids floating point precision loss from parseFloat on repeated additions.
 */
function usdcToMicros(decimal: string): bigint {
  const trimmed = decimal.trim()
  const match = /^(\d+)(?:\.(\d+))?$/.exec(trimmed)
  if (!match) {
    throw new RouteDockPolicyRejectError(`invalid_usdc_amount:${decimal}`)
  }

  const [, whole = '0', fraction = ''] = match
  if (fraction.length > 7) {
    throw new RouteDockPolicyRejectError(`usdc_amount_too_precise:${decimal}`)
  }

  const paddedFraction = fraction.padEnd(7, '0')
  return BigInt(whole) * 10_000_000n + BigInt(paddedFraction)
}

interface ResolvedPreflight {
  manifest: RouteDockManifest
  result: PreflightResult
}

export class RouteDockClient {
  private readonly keypair: Keypair
  private readonly network: 'testnet' | 'mainnet'
  private readonly spendCap: SpendCap | undefined
  private readonly retryPolicy: RetryPolicy | undefined
  private readonly logger: RouteDockLogger | undefined
  private readonly manifestTimeoutMs: number | undefined
  private readonly vault: VaultConfig | undefined

  /**
   * Durable backing store for the local daily spend accumulator (keyed by
   * YYYY-MM-DD). Totals are persisted as decimal strings of microUSDC
   * (1 USDC = 10^7) so stores stay JSON-safe with no precision loss.
   */
  private readonly spendStore: SpendStore

  private x402: X402Client
  private readonly charge: MppChargeClient
  private readonly session: MppSessionClient

  constructor(config: RouteDockClientConfig) {
    this.keypair =
      typeof config.wallet === 'string' ? Keypair.fromSecret(config.wallet) : config.wallet
    this.network = config.network
    this.spendCap = config.spendCap
    this.retryPolicy = config.retryPolicy
    this.spendStore = config.spendStore ?? new InMemorySpendStore({ warn: !!config.spendCap })
    this.logger = config.logger
    this.manifestTimeoutMs = config.manifestTimeoutMs

    if (config.commitmentSecret) {
      _secrets.set(this, config.commitmentSecret)
    }
    this.vault = config.vault

    if (config.commitmentSecret) {
      _secrets.set(this, config.commitmentSecret)
    }

    const secretKey = this.keypair.secret()
    this.x402 = new X402Client(secretKey, this.network, this.retryPolicy)
    this.charge = new MppChargeClient(this.keypair, this.network, this.retryPolicy)
    this.session = new MppSessionClient(this.keypair, this.network, this.retryPolicy)
  }

  /** Fetch manifest and select mode — shared by pay() and estimateCost(). */
  private async _resolveManifest(
    url: string,
    options?: ModeSelectOptions,
  ): Promise<{ manifest: RouteDockManifest; mode: PaymentMode }> {
    const baseUrl = new URL(url).origin
    const manifest = await fetchManifest(baseUrl, this.retryPolicy, this.manifestTimeoutMs)
    const mode = selectMode(manifest, options)
    return { manifest, mode }
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
    const baseUrl = new URL(url).origin
    const manifest = await fetchManifest(baseUrl, this.retryPolicy, this.manifestTimeoutMs)
    const mode = selectMode(manifest, { ...options, ...(this.logger && { logger: this.logger }) })

    if (this.vault?.mode === 'covenant-zk') {
      return this._payWithCovenantVault(url, manifest, mode)
    }

    let result: PaymentResult
    const endpointKey = new URL(url).origin

    switch (mode) {
      case 'x402':
        await this._checkSpendAllowed(manifest.pricing.x402?.amount, endpointKey)
        result = await this.x402.pay(url, manifest)
        break
      case 'mpp-charge':
        await this._checkSpendAllowed(manifest.pricing['mpp-charge']?.amount, endpointKey)
        result = await this.charge.pay(url, manifest)
        break
      case 'mpp-session':
        throw new RouteDockManifestError(
          'Use client.openSession() for mpp-session mode — client.pay() only handles discrete payments',
        )
      default:
        throw new RouteDockManifestError(`Unknown payment mode: ${mode as string}`)
    }

    await this._checkAndRecordSpend(result.amount, endpointKey)
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

  /** Covenant ZK vault path — proof built off-chain, attached as auth signature */
  private async _payWithCovenantVault(
    url: string,
    manifest: RouteDockManifest,
    mode: PaymentMode,
  ): Promise<PaymentResult> {
    if (mode !== 'x402') {
      throw new RouteDockManifestError(
        'covenant-zk vault currently supports x402 mode — force x402 via { forceMode: "x402" }',
      )
    }

    try {
      const { signer } = await prepareCovenantSigner(this.vault!, manifest, mode, this.network)
      const x402 = this.x402.withSigner(signer)
      return await x402.pay(url, manifest)
    } catch (err) {
      if (err instanceof CovenantPolicyError) {
        throw new RouteDockPolicyRejectError((err as CovenantPolicyError).code)
      }
      throw err
    }
  }

  /**
   * Resolve manifest and compute the expected charge WITHOUT submitting any
   * transaction. Safe to call before committing — for approval gates and
   * budget-aware routing.
   */
  async estimateCost(url: string, options?: ModeSelectOptions): Promise<EstimateCostResult> {
    const { manifest, mode } = await this._resolveManifest(url, options)

    let amount: string
    switch (mode) {
      case 'x402':
        amount = manifest.pricing.x402!.amount
        break
      case 'mpp-charge':
        amount = manifest.pricing['mpp-charge']!.amount
        break
      case 'mpp-session':
        amount = manifest.pricing['mpp-session']!.rate
        break
      default:
        throw new RouteDockManifestError(`Unknown payment mode: ${mode as string}`)
    }

    return { amount, asset: manifest.asset, mode, manifest }
  }

  /**
   * Open a sustained MPP session at `url`. Verifies mpp-session is supported
   * before opening a channel. Returns a SessionHandle for streaming + closing.
   *
   * By default the session auto-closes after a wall-clock timeout (1h) so an
   * orphaned channel cannot keep collateral locked on-chain — override or
   * disable via `options.maxDurationMs`.
   */
  async openSession(url: string, options?: SessionOptions): Promise<SessionHandle> {
    const { manifest, result: preflight } = await this._resolvePreflight(url, {
      forceMode: 'mpp-session',
    })

    this._assertNetworkMatch(preflight)
    const baseUrl = new URL(url).origin
    const manifest = await fetchManifest(baseUrl, this.retryPolicy, this.manifestTimeoutMs)

    if (!preflight.compliance.sessionReady) {
      throw new RouteDockManifestError(
        'commitmentSecret is required in RouteDockClientConfig for mpp-session mode',
      )
    }

    const secret = _secrets.get(this)
    if (!secret) {
      throw new RouteDockManifestError(
        'commitmentSecret is required in RouteDockClientConfig for mpp-session mode',
      )
    }

    return this.session.openSession(url, manifest, secret, options)
  }

  /**
   * Remove the commitment secret from memory and make it eligible for GC.
   * Call when this client instance is no longer needed — particularly in
   * long-lived processes or Worker threads.
   */
  dispose(): void {
    _secrets.delete(this)
  }

  private async _resolvePreflight(
    url: string,
    options: ModeSelectOptions = {},
  ): Promise<ResolvedPreflight> {
    const baseUrl = new URL(url).origin
    const manifest = await fetchManifest(baseUrl, this.retryPolicy)
    const selectedMode = selectMode(manifest, options)
    const compliance = await this._buildComplianceFlags(manifest, selectedMode)

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

  private async _buildComplianceFlags(
    manifest: RouteDockManifest,
    selectedMode: PaymentMode,
  ): Promise<PreflightComplianceFlags> {
    const spendCapConfigured = this.spendCap !== undefined
    const assetMatch = !this.spendCap || manifest.asset === this.spendCap.asset
    const spendCapCoversSelectedMode = await this._canAffordEstimatedSpend(
      this._getEstimatedSpendForMode(manifest, selectedMode),
    )
    const networkMatch = manifest.network === this.network
    const sessionReady = !manifest.modes.includes('mpp-session') || Boolean(_secrets.get(this))
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
  private async _checkSpendAllowed(amount: string | undefined, endpointKey: string): Promise<void> {
    if (!this.spendCap || !amount) return

    const today = new Date().toISOString().slice(0, 10)
    const persisted = await this.spendStore.read()
    const current: DailySpend =
      persisted && persisted.date === today
        ? persisted
        : { date: today, totalMicros: '0', endpoints: {} }

    const amountMicros = usdcToMicros(amount)
    const total = BigInt(current.totalMicros)

    const endpointCapStr = this.spendCap.endpointCaps?.[endpointKey]
    if (endpointCapStr !== undefined) {
      const endpointCapMicros = usdcToMicros(endpointCapStr)
      const endpointTotal = BigInt(current.endpoints[endpointKey] ?? '0')
      if (endpointTotal + amountMicros > endpointCapMicros) {
        throw new RouteDockPolicyRejectError('local_endpoint_cap_exceeded')
      }
    }

    const globalCapMicros = usdcToMicros(this.spendCap.daily)
    if (total + amountMicros > globalCapMicros) {
      throw new RouteDockPolicyRejectError('local_daily_cap_exceeded')
    }
  }

  /** Record successful spend after settlement completes. */
  private async _checkAndRecordSpend(amount: string, endpointKey: string): Promise<void> {
    if (!this.spendCap) return

    const today = new Date().toISOString().slice(0, 10)
    const persisted = await this.spendStore.read()
    const current: DailySpend =
      persisted && persisted.date === today
        ? persisted
        : { date: today, totalMicros: '0', endpoints: {} }

    const amountMicros = usdcToMicros(amount)
    const total = BigInt(current.totalMicros)

    const endpointCapStr = this.spendCap.endpointCaps?.[endpointKey]
    if (endpointCapStr !== undefined) {
      const endpointCapMicros = usdcToMicros(endpointCapStr)
      const endpointTotal = BigInt(current.endpoints[endpointKey] ?? '0')
      if (endpointTotal + amountMicros > endpointCapMicros) {
        throw new RouteDockPolicyRejectError('local_endpoint_cap_exceeded')
      }
    }

    const globalCapMicros = usdcToMicros(this.spendCap.daily)
    if (total + amountMicros > globalCapMicros) {
      throw new RouteDockPolicyRejectError('local_daily_cap_exceeded')
    }

    current.totalMicros = (total + amountMicros).toString()
    if (endpointCapStr !== undefined) {
      current.endpoints[endpointKey] =
        (BigInt(current.endpoints[endpointKey] ?? '0') + amountMicros).toString()
    }
    await this.spendStore.write(current)
  }

  private async _canAffordEstimatedSpend(amount: string | undefined): Promise<boolean> {
    if (!this.spendCap || !amount) return true

    const today = new Date().toISOString().slice(0, 10)
    const persisted = await this.spendStore.read()
    const current: DailySpend =
      persisted && persisted.date === today
        ? persisted
        : { date: today, totalMicros: '0', endpoints: {} }

    const amountMicros = usdcToMicros(amount)
    const capMicros = usdcToMicros(this.spendCap.daily)
    return BigInt(current.totalMicros) + amountMicros <= capMicros
  }
}

