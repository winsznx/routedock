import { Keypair } from '@stellar/stellar-sdk'
import { fetchManifest, selectMode, type ModeSelectOptions } from './ModeRouter.js'
import { X402Client } from './x402Client.js'
import { MppChargeClient } from './MppChargeClient.js'
import { MppSessionClient } from './MppSessionClient.js'
import type { PaymentResult, SessionHandle } from '../types.js'
import {
  RouteDockManifestError,
  RouteDockPolicyRejectedError,
} from '../types.js'

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
}

export class RouteDockClient {
  private readonly keypair: Keypair
  private readonly network: 'testnet' | 'mainnet'
  private readonly spendCap: SpendCap | undefined
  private readonly commitmentSecret: string | undefined

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

    const secretKey = this.keypair.secret()
    this.x402 = new X402Client(secretKey, this.network)
    this.charge = new MppChargeClient(this.keypair, this.network)
    this.session = new MppSessionClient(this.keypair, this.network)
  }

  /**
   * Pay for one request at `url`. Fetches manifest, selects payment mode,
   * checks local spend cap, executes payment, returns result.
   */
  async pay(url: string, options?: ModeSelectOptions): Promise<PaymentResult> {
    const baseUrl = new URL(url).origin
    const manifest = await fetchManifest(baseUrl)
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
    const manifest = await fetchManifest(baseUrl)

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
      this.dailySpend = { date: today, total: 0 }
    }

    const amountNum = parseFloat(amount)
    const capNum = parseFloat(this.spendCap.daily)
    if (this.dailySpend.total + amountNum > capNum) {
      throw new RouteDockPolicyRejectedError('local_daily_cap_exceeded')
    }

    this.dailySpend.total += amountNum
  }
}
