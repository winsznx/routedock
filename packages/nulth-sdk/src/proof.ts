import { createHash } from 'node:crypto'
import { Address, hash, scValToNative, xdr } from '@stellar/stellar-sdk'
import { NulthPolicyError, type PaymentAuthContext } from './types.js'

/** SHA-256 hex digest */
export function sha256Hex(data: Buffer | string): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  return createHash('sha256').update(buf).digest('hex')
}

/** Commitment to the daily cap — cap value never appears on-chain */
export function commitDailyCap(dailyCapStroops: bigint, witnessSecret: string): string {
  return sha256Hex(`${witnessSecret}:cap:${dailyCapStroops.toString()}`)
}

/** Commitment to sorted allowlist — individual payees never published */
export function commitAllowlist(payees: readonly string[], witnessSecret: string): string {
  const sorted = [...payees].sort().join(',')
  return sha256Hex(`${witnessSecret}:allowlist:${sorted}`)
}

/** Hash a payee for public inputs without revealing the full allowlist */
export function hashPayee(payee: string): string {
  return sha256Hex(`payee:${payee}`)
}

/** Ledger day bucket aligned with agent-vault (17280 ledgers ≈ 24h) */
export function dayBucket(ledgerSequence: number): number {
  return Math.floor(ledgerSequence / 17280)
}

/** Auth digest bound into the ZK proof (mirrors OZ smart account binding) */
export function authDigestFromEntry(authEntryBase64: string): string {
  const entryHash = hash(Buffer.from(authEntryBase64, 'base64'))
  return sha256Hex(entryHash)
}

/**
 * Verify that the Soroban auth entry actually being signed matches the
 * off-chain payment context the policy was checked against. Without this,
 * the policy (allowlist + daily cap) checks `context.payee` /
 * `context.amountStroops` while a completely different transfer — a
 * different recipient, amount, or asset — can be the one that actually
 * gets signed and submitted.
 *
 * Throws NulthPolicyError('auth_entry_mismatch', ...) naming the field
 * that failed to match, or if the entry doesn't even decode as a
 * `transfer` invocation.
 */
export function assertAuthEntryMatchesContext(
  authEntry: string,
  from: string,
  ctx: Omit<PaymentAuthContext, 'authEntry'>,
): void {
  let preimage: xdr.HashIdPreimage
  try {
    preimage = xdr.HashIdPreimage.fromXDR(authEntry, 'base64')
  } catch {
    throw new NulthPolicyError('auth_entry_mismatch', 'authEntry does not decode as a HashIdPreimage')
  }

  if (preimage.switch() !== xdr.EnvelopeType.envelopeTypeSorobanAuthorization()) {
    throw new NulthPolicyError(
      'auth_entry_mismatch',
      'authEntry is not a Soroban authorization preimage',
    )
  }

  const inv = preimage.sorobanAuthorization().invocation()

  if (inv.subInvocations().length !== 0) {
    throw new NulthPolicyError('auth_entry_mismatch', 'authEntry has unexpected sub-invocations')
  }

  if (
    inv.function().switch() !== xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn()
  ) {
    throw new NulthPolicyError('auth_entry_mismatch', 'authEntry does not invoke a contract function')
  }

  const fn = inv.function().contractFn()

  const contractAddress = Address.fromScAddress(fn.contractAddress()).toString()
  if (contractAddress !== ctx.assetContract) {
    throw new NulthPolicyError(
      'auth_entry_mismatch',
      `authEntry contract ${contractAddress} does not match assetContract ${ctx.assetContract}`,
    )
  }

  const functionName = fn.functionName().toString()
  if (functionName !== 'transfer') {
    throw new NulthPolicyError(
      'auth_entry_mismatch',
      `authEntry function ${functionName} does not match expected transfer`,
    )
  }

  const args = fn.args()
  if (args.length !== 3) {
    throw new NulthPolicyError('auth_entry_mismatch', `authEntry transfer has ${args.length} args, expected 3`)
  }

  const entryFrom = scValToNative(args[0]!) as string
  if (entryFrom !== from) {
    throw new NulthPolicyError(
      'auth_entry_mismatch',
      `authEntry from ${entryFrom} does not match nulthAccount ${from}`,
    )
  }

  const entryTo = scValToNative(args[1]!) as string
  if (entryTo !== ctx.payee) {
    throw new NulthPolicyError(
      'auth_entry_mismatch',
      `authEntry to ${entryTo} does not match paymentContext.payee ${ctx.payee}`,
    )
  }

  const entryAmount = scValToNative(args[2]!) as bigint
  if (entryAmount !== ctx.amountStroops) {
    throw new NulthPolicyError(
      'auth_entry_mismatch',
      `authEntry amount ${entryAmount} does not match paymentContext.amountStroops ${ctx.amountStroops}`,
    )
  }
}

export type ProverBackend = 'mock'

export const DEFAULT_PROVER: ProverBackend = 'mock'

/**
 * Deterministic insecure proof bytes for testnet/dev only.
 *
 * @internal
 */
export function insecureMockProof(preimage: string): string {
  return createHash('sha512').update(`nulth:${preimage}`).digest('base64')
}

/** Encode proof as the Soroban auth signature Val (base64 JSON) */
export function encodeAuthSignature(proof: import('./types.js').NulthProof): string {
  const payload: import('./types.js').NulthAuthSignature = {
    nulth: 'zk-v1',
    proof,
  }
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
}

/** Decode an auth signature produced by {@link encodeAuthSignature} */
export function decodeAuthSignature(encoded: string): import('./types.js').NulthAuthSignature {
  const raw = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as unknown
  if (
    typeof raw !== 'object' ||
    raw === null ||
    (raw as { nulth?: string }).nulth !== 'zk-v1'
  ) {
    throw new Error('Invalid Nulth ZK auth signature')
  }
  return raw as import('./types.js').NulthAuthSignature
}

/** Convert decimal USDC string to stroops (7 decimals) */
export { usdcToStroops } from './usdc.js'
