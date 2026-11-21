import { Address, hash, scValToNative, xdr } from '@stellar/stellar-sdk'
import { NulthPolicyError, type PaymentAuthContext } from './types.js'
import {
  base64ToBytes,
  bytesToBase64,
  bytesToHex,
  bytesToUtf8,
  sha256Bytes,
  sha512Bytes,
  utf8ToBytes,
} from './encoding.js'

/** SHA-256 hex digest */
export function sha256Hex(data: Uint8Array | string): string {
  return bytesToHex(sha256Bytes(data))
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

/** Default max ledgers a signed auth entry may stay valid past the payment ledger (~10 min). */
export const DEFAULT_AUTH_EXPIRY_WINDOW_LEDGERS = 120

/** Auth digest bound into the ZK proof (mirrors OZ smart account binding) */
export function authDigestFromEntry(authEntryBase64: string): string {
  const entryHash = hash(base64ToBytes(authEntryBase64) as Parameters<typeof hash>[0])
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
  opts: { expiryLedger?: number; authExpiryWindowLedgers?: number } = {},
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

  const authExpiry = preimage.sorobanAuthorization().signatureExpirationLedger()
  const window = opts.authExpiryWindowLedgers ?? DEFAULT_AUTH_EXPIRY_WINDOW_LEDGERS
  if (authExpiry < ctx.ledgerSequence) {
    throw new NulthPolicyError(
      'auth_expiry_out_of_policy',
      `authEntry expiration ledger ${authExpiry} is below ledgerSequence ${ctx.ledgerSequence}`,
    )
  }
  if (opts.expiryLedger !== undefined && authExpiry > opts.expiryLedger) {
    throw new NulthPolicyError(
      'auth_expiry_out_of_policy',
      `authEntry expiration ledger ${authExpiry} is past the session expiry ledger ${opts.expiryLedger}`,
    )
  }
  if (authExpiry > ctx.ledgerSequence + window) {
    throw new NulthPolicyError(
      'auth_expiry_out_of_policy',
      `authEntry expiration ledger ${authExpiry} is more than ${window} ledgers past ledgerSequence ${ctx.ledgerSequence}`,
    )
  }
  if (dayBucket(authExpiry) !== dayBucket(ctx.ledgerSequence)) {
    throw new NulthPolicyError(
      'auth_expiry_out_of_policy',
      'authEntry expiration ledger falls in a different day bucket than ledgerSequence',
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
  return bytesToBase64(sha512Bytes(`nulth:${preimage}`))
}

/** Encode proof as the Soroban auth signature Val (base64 JSON) */
export function encodeAuthSignature(proof: import('./types.js').NulthProof): string {
  const payload: import('./types.js').NulthAuthSignature = {
    nulth: 'zk-v1',
    proof,
  }
  return bytesToBase64(utf8ToBytes(JSON.stringify(payload)))
}

/** Decode an auth signature produced by {@link encodeAuthSignature} */
export function decodeAuthSignature(encoded: string): import('./types.js').NulthAuthSignature {
  const raw = JSON.parse(bytesToUtf8(base64ToBytes(encoded))) as unknown
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
