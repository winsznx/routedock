import { Keypair } from '@stellar/stellar-sdk'
import { fetchManifest, selectMode, type ModeSelectOptions } from './ModeRouter.js'
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

  const [, whole, fraction = ''] = match
  if (fraction.length > 7) {
    throw new RouteDockPolicyRejectError(`usdc_amount_too_precise:${decimal}`)
  }

  const paddedFraction = fraction.padEnd(7, '0')
  return BigInt(whole) * 10_000_000n + BigInt(paddedFraction)
}

export class RouteDockClient {
  private readonly keypair: Keypair
  private readonly network: 'testnet' | 'mainnet'
  private readonly spendCap: SpendCap | undefined
  private readonly commitmentSecret: string | undefined
  private readonly retryPolicy: RetryPolicy | undefined

  /** Local daily accumulator keyed by YYYY-MM-DD, total in microUSDC (1 USDC = 10^7) */
  private dailySpend: { date: string; total: bigint } = { date: '', total: 0n }

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
    const baseUrl = new URL(url).origin
    const manifest = await fetchManifest(baseUrl, this.retryPolicy)
    const mode = selectMode(manifest, options)

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

    this._checkAndRecordSpend(result.amount)
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

  /** Check local daily cap and record the spend. Throws if cap exceeded. */
  private _checkAndRecordSpend(amount: string): void {
    if (!this.spendCap) return

    const today = new Date().toISOString().slice(0, 10)
    if (this.dailySpend.date !== today) {
      this.dailySpend = { date: today, total: 0n }
    }

    const amountMicros = usdcToMicros(amount)
    const capMicros = usdcToMicros(this.spendCap.daily)

    if (this.dailySpend.total + amountMicros > capMicros) {
      throw new RouteDockPolicyRejectError('local_daily_cap_exceeded')
    }

    this.dailySpend.total += amountMicros
  }
}
