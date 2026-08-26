import { Keypair, Horizon } from '@stellar/stellar-sdk'
import { fetchManifest, selectMode, type ModeSelectOptions, type RouteDockLogger } from './ModeRouter.js'
import { X402Client } from './x402Client.js'
import { MppChargeClient } from './MppChargeClient.js'
import { MppSessionClient } from './MppSessionClient.js'
import { prepareNulthSigner, NulthPolicyError, type NulthVaultConfig } from './NulthVault.js'
import type { PaymentResult, SessionHandle, SessionOptions, RouteDockManifest, PaymentMode, EstimateCostResult } from '../types.js'
import { RouteDockManifestError, RouteDockPolicyRejectError, RouteDockTrustlineError } from '../errors.js'
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

export type VaultConfig = NulthVaultConfig

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
   * Out-of-band trust anchor for manifests: the Stellar payee (G...) the client
   * expects the provider to be (e.g. the account registered in the on-chain
   * provider registry, or a pinned/allowlisted key). When set, every fetched
   * manifest's `payee` must equal this value or payment is refused with
   * `RouteDockSignatureError`. Without it, a self-signed manifest proves nothing
   * about who served it, so set this whenever you obtained a provider address
   * from a registry.
   */
  expectedPayee?: string

  /**
   * Vault custody mode. When `nulth`, payments use a Nulth account as payer
   * with off-chain ZK proofs attached as auth signatures.
   */
  vault?: VaultConfig
}

/**
 * Convert a decimal USDC string (e.g. "0.0001", "1.00") to an exact
 * integer count of microUSDC (1 USDC = 10^7 units on Stellar) as a bigint.
 * Avoids floating point precision loss from parseFloat on repeated additions.
 */
export function usdcToMicros(decimal: string): bigint {
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

/**
 * Well-known Stellar asset issuers, keyed by asset code then network.
 * Used by the trustline preflight to produce exact remediation commands.
 */
const ASSET_ISSUERS: Record<string, Record<string, string>> = {
  USDC: {
    testnet: 'GBQY2K7IZDSK5QN3OF6ZSOLQ6CWAH5Q5JXEG5Q3S4OD5B7LYO24B6B6L',
    mainnet: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  },
}

function getAssetIssuer(asset: string, network: string): string {
  return ASSET_ISSUERS[asset]?.[network] ?? ''
}

/** Trustline cache TTL — 5 minutes, since trustlines are rarely added at runtime. */
const TRUSTLINE_CACHE_TTL_MS = 300_000

interface TrustlineCacheEntry {
  exists: true
  expiresAt: number
}

export class RouteDockClient {
  /** Per-(account,asset) trustline existence cache keyed by `${network}:${pubkey}:${asset}` */
  private static _trustlineCache = new Map<string, TrustlineCacheEntry>()

  private readonly keypair: Keypair
  private readonly network: 'testnet' | 'mainnet'
  private readonly spendCap: SpendCap | undefined
  private readonly retryPolicy: RetryPolicy | undefined
  private readonly logger: RouteDockLogger | undefined
  private readonly manifestTimeoutMs: number | undefined
  private readonly expectedPayee: string | undefined
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

  /**
   * Promise-chain mutex for serializing read-modify-write on the spend
   * accumulator. Each pay() call awaits the previous one, preventing
   * concurrent read-modify-write races that could overrun the cap.
   */
  private _spendMutex: Promise<unknown> = Promise.resolve()

  /**
   * Pending spend reservations keyed by reserveId. Used by _rollbackSpend
   * to revert the accumulator when a payment fails after reservation.
   */
  private _pendingReserves = new Map<string, { endpointKey: string; amountMicros: bigint }>()

  constructor(config: RouteDockClientConfig) {
    this.keypair =
      typeof config.wallet === 'string' ? Keypair.fromSecret(config.wallet) : config.wallet
    this.network = config.network
    this.spendCap = config.spendCap
    this.retryPolicy = config.retryPolicy
    // Only warn about non-durability when a spend cap is actually configured.
    this.spendStore = config.spendStore ?? new InMemorySpendStore({ warn: !!config.spendCap })
    this.logger = config.logger
    this.manifestTimeoutMs = config.manifestTimeoutMs
    this.expectedPayee = config.expectedPayee

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
    const manifest = await fetchManifest(baseUrl, this.retryPolicy, this.manifestTimeoutMs, this.expectedPayee)
    const mode = selectMode(manifest, options)
    return { manifest, mode }
  }

  /**
   * Serialize async work through the per-instance spend mutex so concurrent
   * pay() calls cannot interleave read-modify-write on the accumulator.
   */
  private _withSpendMutex<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this._spendMutex
    let next: Promise<T>
    next = prev.then(fn, fn)
    this._spendMutex = next.then(() => {}, () => {})
    return next
  }

  /**
   * Check that the payer has a trustline for the payment asset. Safe to
   * call before committing to a payment — for approval gates and manual
   * trustline remediation.
   */
  async preflight(manifest: RouteDockManifest): Promise<void> {
    await this._checkTrustline(manifest)
  }

  /**
   * Verify via Horizon that the payer account has a trustline for the
   * payment asset declared in the manifest. Throws RouteDockTrustlineError
   * with an exact Stellar CLI change-trust remediation command when the
   * trustline is missing. Results are cached per (account, asset) so the
   * per-payment overhead is one RPC call amortized to zero after the first.
   */
  private async _checkTrustline(
    manifest: RouteDockManifest,
  ): Promise<void> {
    const cacheKey = `${this.network}:${this.keypair.publicKey()}:${manifest.asset}`
    const cached = RouteDockClient._trustlineCache.get(cacheKey)
    if (cached && Date.now() < cached.expiresAt) return

    const horizonUrl =
      this.network === 'testnet'
        ? 'https://horizon-testnet.stellar.org'
        : 'https://horizon.stellar.org'

    const server = new Horizon.Server(horizonUrl)
    try {
      const account = await server.loadAccount(this.keypair.publicKey())
      const balances = account.balances as unknown[]
      const hasTrustline = balances.some(
        (b) =>
          typeof b === 'object' &&
          b !== null &&
          'asset_code' in b &&
          (b as Record<string, unknown>).asset_code === manifest.asset,
      )
      if (!hasTrustline) {
        const issuer = getAssetIssuer(manifest.asset, this.network)
        const remediation = issuer
          ? `Run: stellar tx new --source ${this.keypair.publicKey()} --network ${this.network} change-trust --asset ${manifest.asset}:${issuer} --limit 100000`
          : `Establish a trustline for ${manifest.asset} with the appropriate issuer on ${this.network}`
        throw new RouteDockTrustlineError(manifest.asset, issuer || 'unknown', remediation)
      }
      RouteDockClient._trustlineCache.set(cacheKey, {
        exists: true,
        expiresAt: Date.now() + TRUSTLINE_CACHE_TTL_MS,
      })
    } catch (err) {
      if (err instanceof RouteDockTrustlineError) throw err
      this.logger?.(
        `[RouteDock] Trustline preflight: could not verify trustline for ${manifest.asset} — continuing`,
      )
    }
  }

  /**
   * Pay for one request at `url`. Fetches manifest, selects payment mode,
   * runs trustline preflight, reserves local spend cap BEFORE executing the
   * payment, then commits the spend record on success. Rolls back the
   * reservation if the on-chain payment fails. Concurrent pay() calls are
   * serialized through a per-instance mutex to prevent spend-cap overrun.
   */
  async pay(url: string, options?: ModeSelectOptions): Promise<PaymentResult> {
    const baseUrl = new URL(url).origin
    const manifest = await fetchManifest(baseUrl, this.retryPolicy, this.manifestTimeoutMs, this.expectedPayee)
    const mode = selectMode(manifest, { ...options, ...(this.logger && { logger: this.logger }) })

    await this._checkTrustline(manifest)

    if (this.vault?.mode === 'nulth') {
      return this._payWithNulthVault(url, manifest, mode)
    }

    let amount: string
    switch (mode) {
      case 'x402':
        amount = manifest.pricing.x402!.amount
        break
      case 'mpp-charge':
        amount = manifest.pricing['mpp-charge']!.amount
        break
      case 'mpp-session':
        throw new RouteDockManifestError(
          'Use client.openSession() for mpp-session mode — client.pay() only handles discrete payments',
        )
      default:
        throw new RouteDockManifestError(`Unknown payment mode: ${mode as string}`)
    }

    const reserveId = await this._checkAndReserveSpend(amount, baseUrl)

    let result: PaymentResult
    try {
      switch (mode) {
        case 'x402':
          result = await this.x402.pay(url, manifest)
          break
        case 'mpp-charge':
          result = await this.charge.pay(url, manifest)
          break
        default:
          throw new RouteDockManifestError(`Unknown payment mode: ${mode as string}`)
      }
    } catch (err) {
      await this._rollbackSpend(reserveId).catch(() => {})
      throw err
    }

    await this._commitSpend(reserveId)
    return result
  }

  /** Nulth ZK vault path — proof built off-chain, attached as auth signature */
  private async _payWithNulthVault(
    url: string,
    manifest: import('../types.js').RouteDockManifest,
    mode: import('../types.js').PaymentMode,
  ): Promise<PaymentResult> {
    const prover = this.vault?.prover ?? 'mock';
    if (this.network === 'mainnet' && prover === 'mock') {
      throw new RouteDockManifestError('nulth vault uses a MOCK Groth16 prover and cannot be used on mainnet');
    }
    if (mode !== 'x402') {
      throw new RouteDockManifestError(
        'nulth vault currently supports x402 mode — force x402 via { forceMode: "x402" }',
      )
    }

    try {
      const { signer } = await prepareNulthSigner(this.vault!, manifest, mode, this.network)
      const x402 = this.x402.withSigner(signer)
      const result = await x402.pay(url, manifest)
      return result
    } catch (err) {
      if (err instanceof NulthPolicyError) {
        throw new RouteDockPolicyRejectError((err as NulthPolicyError).code)
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
    const baseUrl = new URL(url).origin
    const manifest = await fetchManifest(baseUrl, this.retryPolicy, this.manifestTimeoutMs, this.expectedPayee)

    if (!manifest.modes.includes('mpp-session')) {
      throw new RouteDockManifestError(
        `Provider at ${baseUrl} does not support mpp-session mode`,
      )
    }

    const secret = _secrets.get(this)
    if (!secret) {
      throw new RouteDockManifestError(
        'commitmentSecret is required in RouteDockClientConfig for mpp-session mode',
      )
    }

    const endpointKey = new URL(url).origin
    const onSpend = this.spendCap
      ? (amount: string) => this._recordSessionSpend(amount, endpointKey)
      : undefined

    return this.session.openSession(url, manifest, secret, options, onSpend)
  }

  /**
   * Record spend for an MPP session voucher. Called before each voucher
   * fetch in stream(). Enforces the same local daily and per-endpoint caps
   * as discrete pay() calls. Returns a commit function to clean up the
   * reservation after the voucher fetch succeeds.
   */
  private async _recordSessionSpend(amount: string, endpointKey: string): Promise<void> {
    const reserveId = await this._checkAndReserveSpend(amount, endpointKey)
    if (reserveId) {
      // For sessions, commit immediately — the spend is final once the
      // voucher is issued. No rollback path on voucher fetch failure since
      // the cap is checked before the fetch (if it fails, no reserve was made).
      await this._commitSpend(reserveId)
    }
  }

  /**
   * Remove the commitment secret from memory and make it eligible for GC.
   * Call when this client instance is no longer needed — particularly in
   * long-lived processes or Worker threads.
   */
  dispose(): void {
    _secrets.delete(this)
  }

  /**
   * Reserve spend against local daily caps BEFORE dispatching payment.
   * Returns a reserveId that must be passed to _commitSpend() on success
   * or _rollbackSpend() on failure.
   *
   * The entire read-check-write is serialized through the per-instance
   * mutex (_withSpendMutex) so concurrent pay() calls cannot interleave
   * and overrun the cap.
   *
   * Enforcement order:
   *   1. Per-endpoint cap (if `endpointCaps[endpointKey]` is set) — checked first.
   *   2. Global daily cap — checked second.
   *
   * Both limits are independent: a payment is only reserved after **both** pass.
   * All spend (regardless of endpoint) counts toward the global accumulator.
   */
  private async _checkAndReserveSpend(amount: string, endpointKey: string): Promise<string> {
    if (!this.spendCap) return ''

    return this._withSpendMutex(async () => {
      const today = new Date().toISOString().slice(0, 10)
      const persisted = await this.spendStore.read()
      const current: DailySpend =
        persisted && persisted.date === today
          ? persisted
          : { date: today, totalMicros: '0', endpoints: {} }

      const amountMicros = usdcToMicros(amount)
      const total = BigInt(current.totalMicros)

      // 1. Per-endpoint cap check
      const endpointCapStr = this.spendCap!.endpointCaps?.[endpointKey]
      if (endpointCapStr !== undefined) {
        const endpointCapMicros = usdcToMicros(endpointCapStr)
        const endpointTotal = BigInt(current.endpoints[endpointKey] ?? '0')
        if (endpointTotal + amountMicros > endpointCapMicros) {
          throw new RouteDockPolicyRejectError('local_endpoint_cap_exceeded')
        }
      }

      // 2. Global daily cap check
      const globalCapMicros = usdcToMicros(this.spendCap!.daily)
      if (total + amountMicros > globalCapMicros) {
        throw new RouteDockPolicyRejectError('local_daily_cap_exceeded')
      }

      // Both checks passed — reserve the spend (tentatively record)
      const reserveId = `${Date.now()}-${Math.random().toString(36).slice(2)}`
      this._pendingReserves.set(reserveId, { endpointKey, amountMicros })
      current.totalMicros = (total + amountMicros).toString()
      if (endpointCapStr !== undefined) {
        current.endpoints[endpointKey] =
          (BigInt(current.endpoints[endpointKey] ?? '0') + amountMicros).toString()
      }
      await this.spendStore.write(current)
      return reserveId
    })
  }

  /**
   * Commit a previously reserved spend after payment succeeds. For discrete
   * pay() calls this is a no-op (the spend was already recorded by reserve).
   * Reserved for future use if the committed amount differs from the reserved.
   */
  private async _commitSpend(reserveId: string): Promise<void> {
    this._pendingReserves.delete(reserveId)
  }

  /**
   * Rollback a previously reserved spend when payment fails. Reverts the
   * tentative accumulator write done by _checkAndReserveSpend.
   */
  private async _rollbackSpend(reserveId: string): Promise<void> {
    if (!this.spendCap || !reserveId) return

    const reserve = this._pendingReserves.get(reserveId)
    if (!reserve) return
    this._pendingReserves.delete(reserveId)

    const { endpointKey, amountMicros } = reserve

    await this._withSpendMutex(async () => {
      const today = new Date().toISOString().slice(0, 10)
      const persisted = await this.spendStore.read()
      if (!persisted || persisted.date !== today) return

      const currentTotal = BigInt(persisted.totalMicros)
      persisted.totalMicros = (currentTotal - amountMicros).toString()

      if (persisted.endpoints[endpointKey]) {
        const endpointTotal = BigInt(persisted.endpoints[endpointKey])
        const newEndpointTotal = endpointTotal - amountMicros
        if (newEndpointTotal <= 0n) {
          delete persisted.endpoints[endpointKey]
        } else {
          persisted.endpoints[endpointKey] = newEndpointTotal.toString()
        }
      }

      await this.spendStore.write(persisted)
    })
  }
}
