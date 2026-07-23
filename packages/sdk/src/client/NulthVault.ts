/**
 * NulthVault — self-contained Nulth ZK account support for RouteDock SDK.
 *
 * All nulth-sdk logic is inlined here so this file has zero imports from
 * @routedock/nulth-sdk. This avoids workspace-resolution issues in CI
 * where the package may not be built before the DTS worker runs.
 */
import { createHash } from 'node:crypto'
import { rpc, hash } from '@stellar/stellar-sdk'
import type { ClientStellarSigner } from '@x402/stellar'
import type { SignAuthEntry } from '@stellar/stellar-sdk/contract'
import type { RouteDockManifest, PaymentMode, VaultMode } from '../types.js'
import { RouteDockManifestError } from '../errors.js'

// ---------------------------------------------------------------------------
// Inlined types (from @routedock/nulth-sdk/types)
// ---------------------------------------------------------------------------

export interface NulthPolicyState {
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

export interface NulthProof {
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

export interface NulthAuthSignature {
  nulth: 'zk-v1'
  proof: NulthProof
}

export interface NulthClientConfig {
  nulthAccount: string
  policy: NulthPolicyState
  verifierContract?: string
}

export class NulthPolicyError extends Error {
  readonly code: 'payee_not_allowed' | 'daily_cap_exceeded' | 'session_expired'
  constructor(code: NulthPolicyError['code'], message: string) {
    super(message)
    this.name = 'NulthPolicyError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// Inlined proof utilities (from @routedock/nulth-sdk/proof)
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
  return createHash('sha512').update(`nulth:${preimage}`).digest('base64')
}

function encodeAuthSignature(proof: NulthProof): string {
  const payload: NulthAuthSignature = { nulth: 'zk-v1', proof }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
}

function usdcToStroops(amount: string): bigint {
  const [whole = '0', frac = ''] = amount.split('.')
  const padded = (frac + '0000000').slice(0, 7)
  return BigInt(whole) * 10_000_000n + BigInt(padded)
}

// ---------------------------------------------------------------------------
// Inlined NulthClient (from @routedock/nulth-sdk/NulthClient)
// ---------------------------------------------------------------------------

class NulthClient {
  private policy: NulthPolicyState

  constructor(private readonly config: NulthClientConfig) {
    this.policy = { ...config.policy }
  }

  get nulthAccount(): string { return this.config.nulthAccount }
  get allowlistCommitment(): string { return this.policy.allowlistCommitment }
  get capCommitment(): string {
    return commitDailyCap(this.policy.dailyCapStroops, this.policy.witnessSecret)
  }

  buildPaymentAuthProof(context: PaymentAuthContext): NulthProof {
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
      this.config.nulthAccount,
    ].join('|')

    const proof: NulthProof = {
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
      throw new NulthPolicyError('session_expired', 'Nulth session expired')
    }
    if (!this.policy.allowedPayees.includes(context.payee)) {
      throw new NulthPolicyError('payee_not_allowed', `Payee ${context.payee} not in off-chain allowlist`)
    }
    const bucket = dayBucketFromLedger(context.ledgerSequence)
    const spend = bucket === this.policy.dayBucket ? this.policy.dailySpendStroops : 0n
    if (spend + context.amountStroops > this.policy.dailyCapStroops) {
      throw new NulthPolicyError('daily_cap_exceeded', 'Nulth daily cap exceeded')
    }
  }
}

// ---------------------------------------------------------------------------
// Inlined signer types & helpers (from @routedock/nulth-sdk/signer)
// ---------------------------------------------------------------------------

export interface NulthStellarSigner {
  address: string
  signAuthEntry: SignAuthEntry
}

export interface NulthSignerConfig extends NulthClientConfig {
  paymentContext?: Omit<PaymentAuthContext, 'authEntry'>
}

export function createNulthSigner(config: NulthSignerConfig): NulthStellarSigner {
  const client = new NulthClient(config)
  const nulthAccount = config.nulthAccount
  return {
    address: nulthAccount,
    signAuthEntry: async (authEntry) => {
      const ctx = config.paymentContext
      if (!ctx) throw new Error('Nulth paymentContext must be set before signing')
      const proof = client.buildPaymentAuthProof({ authEntry, ...ctx })
      return { signedAuthEntry: encodeAuthSignature(proof), signerAddress: nulthAccount }
    },
  }
}

export function setNulthPaymentContext(
  config: NulthSignerConfig,
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
}): NulthPolicyState {
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
// NulthVault public API
// ---------------------------------------------------------------------------

export interface NulthVaultConfig {
  mode: 'nulth'
  nulthAccount: string
  witnessSecret: string
  allowedPayees: readonly string[]
  dailyCapUsdc: string
  expiryLedger?: number
  verifierContract?: string
}

export function assertNulthVaultManifest(manifest: RouteDockManifest, nulthAccount: string): void {
  if (manifest.vault !== undefined && manifest.vault !== 'nulth') {
    throw new RouteDockManifestError(`Provider vault mode ${manifest.vault} does not match client nulth vault`)
  }
  if (manifest.nulth_account && manifest.nulth_account !== nulthAccount) {
    throw new RouteDockManifestError(`Manifest nulth_account ${manifest.nulth_account} does not match configured ${nulthAccount}`)
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

export async function prepareNulthSigner(
  vault: NulthVaultConfig,
  manifest: RouteDockManifest,
  mode: PaymentMode,
  network: 'testnet' | 'mainnet',
  ledgerSequenceOverride?: number,
): Promise<{ signer: ClientStellarSigner; config: NulthSignerConfig }> {
  assertNulthVaultManifest(manifest, vault.nulthAccount)

  const ledgerSequence = ledgerSequenceOverride ?? (await fetchLedgerSequence(network))
  const policy = createPolicyState({
    dailyCapUsdc: vault.dailyCapUsdc,
    allowedPayees: vault.allowedPayees,
    witnessSecret: vault.witnessSecret,
    ledgerSequence,
    ...(vault.expiryLedger !== undefined ? { expiryLedger: vault.expiryLedger } : {}),
  })

  const config: NulthSignerConfig = {
    nulthAccount: vault.nulthAccount,
    policy,
    ...(vault.verifierContract !== undefined ? { verifierContract: vault.verifierContract } : {}),
  }

  if (mode === 'x402' || mode === 'mpp-charge') {
    setNulthPaymentContext(config, paymentContextFromManifest(manifest, mode, ledgerSequence))
  } else {
    throw new RouteDockManifestError(`Nulth ZK vault does not support payment mode: ${mode}`)
  }

  const signer = createNulthSigner(config)
  return { signer: signer as ClientStellarSigner, config }
}

export type { VaultMode }

export function decodeAuthSignature(encoded: string): NulthAuthSignature {
  const raw = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as unknown
  if (typeof raw !== 'object' || raw === null || (raw as { nulth?: string }).nulth !== 'zk-v1') {
    throw new Error('Invalid Nulth ZK auth signature')
  }
  return raw as NulthAuthSignature
}
