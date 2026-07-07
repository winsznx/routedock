/**
 * CovenantZkVault — self-contained Covenant ZK account support for RouteDock SDK.
 *
 * All covenant-sdk logic is inlined here so this file has zero imports from
 * @routedock/covenant-sdk. This avoids workspace-resolution issues in CI
 * where the package may not be built before the DTS worker runs.
 */
import { createHash } from 'node:crypto'
import { rpc, hash } from '@stellar/stellar-sdk'
import type { ClientStellarSigner } from '@x402/stellar'
import type { SignAuthEntry } from '@stellar/stellar-sdk/contract'
import type { RouteDockManifest, PaymentMode, VaultMode } from '../types.js'
import { RouteDockManifestError } from '../errors.js'

// ---------------------------------------------------------------------------
// Inlined types (from @routedock/covenant-sdk/types)
// ---------------------------------------------------------------------------

export interface CovenantPolicyState {
  dailyCapStroops: bigint
  allowlistCommitment: string
  allowedPayees: readonly string[]
  dailySpendStroops: bigint
  dayBucket: number
  witnessSecret: string
  expiryLedger?: number
}

export interface PaymentAuthContext {
  authEntry: string
  payee: string
  amountStroops: bigint
  assetContract: string
  ledgerSequence: number
}

export interface CovenantZkProof {
  version: 1
  proof: string
  publicInputs: {
    authDigest: string
    allowlistCommitment: string
    capCommitment: string
    payeeHash: string
    amountStroops: string
    dayBucket: string
  }
}

export interface CovenantAuthSignature {
  covenant: 'zk-v1'
  proof: CovenantZkProof
}

export interface CovenantClientConfig {
  covenantAccount: string
  policy: CovenantPolicyState
  verifierContract?: string
}

export class CovenantPolicyError extends Error {
  readonly code: 'payee_not_allowed' | 'daily_cap_exceeded' | 'session_expired'
  constructor(code: CovenantPolicyError['code'], message: string) {
    super(message)
    this.name = 'CovenantPolicyError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// Inlined proof utilities (from @routedock/covenant-sdk/proof)
// ---------------------------------------------------------------------------

function sha256Hex(data: Buffer | string): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  return createHash('sha256').update(buf).digest('hex')
}

function commitDailyCap(dailyCapStroops: bigint, witnessSecret: string): string {
  return sha256Hex(`${witnessSecret}:cap:${dailyCapStroops.toString()}`)
}

function commitAllowlist(payees: readonly string[], witnessSecret: string): string {
  const sorted = [...payees].sort().join(',')
  return sha256Hex(`${witnessSecret}:allowlist:${sorted}`)
}

function hashPayee(payee: string): string {
  return sha256Hex(`payee:${payee}`)
}

function dayBucketFromLedger(ledgerSequence: number): number {
  return Math.floor(ledgerSequence / 17280)
}

function authDigestFromEntry(authEntryBase64: string): string {
  const entryHash = hash(Buffer.from(authEntryBase64, 'base64'))
  return sha256Hex(entryHash)
}

function mockGroth16Proof(preimage: string): string {
  return createHash('sha512').update(`covenant-zk:${preimage}`).digest('base64')
}

function encodeAuthSignature(proof: CovenantZkProof): string {
  const payload: CovenantAuthSignature = { covenant: 'zk-v1', proof }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
}

function usdcToStroops(amount: string): bigint {
  const [whole = '0', frac = ''] = amount.split('.')
  const padded = (frac + '0000000').slice(0, 7)
  return BigInt(whole) * 10_000_000n + BigInt(padded)
}

// ---------------------------------------------------------------------------
// Inlined CovenantClient (from @routedock/covenant-sdk/CovenantClient)
// ---------------------------------------------------------------------------

class CovenantClient {
  private policy: CovenantPolicyState

  constructor(private readonly config: CovenantClientConfig) {
    this.policy = { ...config.policy }
  }

  get covenantAccount(): string { return this.config.covenantAccount }
  get allowlistCommitment(): string { return this.policy.allowlistCommitment }
  get capCommitment(): string {
    return commitDailyCap(this.policy.dailyCapStroops, this.policy.witnessSecret)
  }

  buildPaymentAuthProof(context: PaymentAuthContext): CovenantZkProof {
    this.enforcePolicy(context)

    const bucket = dayBucketFromLedger(context.ledgerSequence)
    if (bucket !== this.policy.dayBucket) {
      this.policy.dayBucket = bucket
      this.policy.dailySpendStroops = 0n
    }

    const authDigest = authDigestFromEntry(context.authEntry)
    const capCommitment = this.capCommitment
    const payeeHash = hashPayee(context.payee)

    const preimage = [
      authDigest, this.policy.allowlistCommitment, capCommitment,
      payeeHash, context.amountStroops.toString(), bucket.toString(),
      this.config.covenantAccount,
    ].join('|')

    const proof: CovenantZkProof = {
      version: 1,
      proof: mockGroth16Proof(preimage),
      publicInputs: {
        authDigest,
        allowlistCommitment: this.policy.allowlistCommitment,
        capCommitment,
        payeeHash,
        amountStroops: context.amountStroops.toString(),
        dayBucket: bucket.toString(),
      },
    }

    this.policy.dailySpendStroops += context.amountStroops
    return proof
  }

  private enforcePolicy(context: PaymentAuthContext): void {
    if (this.policy.expiryLedger !== undefined && context.ledgerSequence > this.policy.expiryLedger) {
      throw new CovenantPolicyError('session_expired', 'Covenant session expired')
    }
    if (!this.policy.allowedPayees.includes(context.payee)) {
      throw new CovenantPolicyError('payee_not_allowed', `Payee ${context.payee} not in off-chain allowlist`)
    }
    const bucket = dayBucketFromLedger(context.ledgerSequence)
    const spend = bucket === this.policy.dayBucket ? this.policy.dailySpendStroops : 0n
    if (spend + context.amountStroops > this.policy.dailyCapStroops) {
      throw new CovenantPolicyError('daily_cap_exceeded', 'Covenant daily cap exceeded')
    }
  }
}

// ---------------------------------------------------------------------------
// Inlined signer types & helpers (from @routedock/covenant-sdk/signer)
// ---------------------------------------------------------------------------

export interface CovenantStellarSigner {
  address: string
  signAuthEntry: SignAuthEntry
}

export interface CovenantSignerConfig extends CovenantClientConfig {
  paymentContext?: Omit<PaymentAuthContext, 'authEntry'>
}

export function createCovenantSigner(config: CovenantSignerConfig): CovenantStellarSigner {
  const client = new CovenantClient(config)
  const covenantAccount = config.covenantAccount
  return {
    address: covenantAccount,
    signAuthEntry: async (authEntry) => {
      const ctx = config.paymentContext
      if (!ctx) throw new Error('Covenant paymentContext must be set before signing')
      const proof = client.buildPaymentAuthProof({ authEntry, ...ctx })
      return { signedAuthEntry: encodeAuthSignature(proof), signerAddress: covenantAccount }
    },
  }
}

export function setCovenantPaymentContext(
  config: CovenantSignerConfig,
  context: Omit<PaymentAuthContext, 'authEntry'>,
): void {
  config.paymentContext = context
}

export function paymentContextFromManifest(
  manifest: {
    payee: string
    asset_contract: string
    pricing: { x402?: { amount: string }; 'mpp-charge'?: { amount: string } }
  },
  mode: 'x402' | 'mpp-charge',
  ledgerSequence: number,
): Omit<PaymentAuthContext, 'authEntry'> {
  const pricing = manifest.pricing[mode]
  if (!pricing) throw new Error(`manifest.pricing.${mode} missing`)
  return {
    payee: manifest.payee,
    amountStroops: usdcToStroops(pricing.amount),
    assetContract: manifest.asset_contract,
    ledgerSequence,
  }
}

export function createPolicyState(input: {
  dailyCapUsdc: string
  allowedPayees: readonly string[]
  witnessSecret: string
  expiryLedger?: number
  ledgerSequence?: number
}): CovenantPolicyState {
  const dailyCapStroops = usdcToStroops(input.dailyCapUsdc)
  return {
    dailyCapStroops,
    allowlistCommitment: commitAllowlist(input.allowedPayees, input.witnessSecret),
    allowedPayees: input.allowedPayees,
    dailySpendStroops: 0n,
    dayBucket: dayBucketFromLedger(input.ledgerSequence ?? 0),
    witnessSecret: input.witnessSecret,
    ...(input.expiryLedger !== undefined ? { expiryLedger: input.expiryLedger } : {}),
  }
}

// ---------------------------------------------------------------------------
// CovenantZkVault public API
// ---------------------------------------------------------------------------

export interface CovenantZkVaultConfig {
  mode: 'covenant-zk'
  covenantAccount: string
  witnessSecret: string
  allowedPayees: readonly string[]
  dailyCapUsdc: string
  expiryLedger?: number
  verifierContract?: string
}

export function assertCovenantVaultManifest(manifest: RouteDockManifest, covenantAccount: string): void {
  if (manifest.vault !== undefined && manifest.vault !== 'covenant-zk') {
    throw new RouteDockManifestError(`Provider vault mode ${manifest.vault} does not match client covenant-zk vault`)
  }
  if (manifest.covenant_account && manifest.covenant_account !== covenantAccount) {
    throw new RouteDockManifestError(`Manifest covenant_account ${manifest.covenant_account} does not match configured ${covenantAccount}`)
  }
}

export async function fetchLedgerSequence(network: 'testnet' | 'mainnet'): Promise<number> {
  const rpcUrl = network === 'testnet'
    ? 'https://soroban-testnet.stellar.org'
    : 'https://soroban.stellar.org'
  const server = new rpc.Server(rpcUrl)
  const latest = await server.getLatestLedger()
  return latest.sequence
}

export async function prepareCovenantSigner(
  vault: CovenantZkVaultConfig,
  manifest: RouteDockManifest,
  mode: PaymentMode,
  network: 'testnet' | 'mainnet',
  ledgerSequenceOverride?: number,
): Promise<{ signer: ClientStellarSigner; config: CovenantSignerConfig }> {
  assertCovenantVaultManifest(manifest, vault.covenantAccount)

  const ledgerSequence = ledgerSequenceOverride ?? (await fetchLedgerSequence(network))
  const policy = createPolicyState({
    dailyCapUsdc: vault.dailyCapUsdc,
    allowedPayees: vault.allowedPayees,
    witnessSecret: vault.witnessSecret,
    ledgerSequence,
    ...(vault.expiryLedger !== undefined ? { expiryLedger: vault.expiryLedger } : {}),
  })

  const config: CovenantSignerConfig = {
    covenantAccount: vault.covenantAccount,
    policy,
    ...(vault.verifierContract !== undefined ? { verifierContract: vault.verifierContract } : {}),
  }

  if (mode === 'x402' || mode === 'mpp-charge') {
    setCovenantPaymentContext(config, paymentContextFromManifest(manifest, mode, ledgerSequence))
  } else {
    throw new RouteDockManifestError(`Covenant ZK vault does not support payment mode: ${mode}`)
  }

  const signer = createCovenantSigner(config)
  return { signer: signer as ClientStellarSigner, config }
}

export type { VaultMode }

export function decodeAuthSignature(encoded: string): CovenantAuthSignature {
  const raw = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as unknown
  if (typeof raw !== 'object' || raw === null || (raw as { covenant?: string }).covenant !== 'zk-v1') {
    throw new Error('Invalid Covenant ZK auth signature')
  }
  return raw as CovenantAuthSignature
}
