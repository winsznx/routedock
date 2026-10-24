import { Address, hash, nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk'
import type { Keypair, SigningCallback } from '@stellar/stellar-sdk'
import { base64ToBytes, bytesToBase64, utf8ToBytes } from './encoding.js'
import { decodeAuthSignature } from './proof.js'
import type { NulthAuthSignature, NulthProof } from './types.js'

/**
 * A Nulth proof travels in the Soroban auth entry's signature field instead of
 * an ed25519 signature, so stellar-sdk's default `authorizeEntry` (which decodes
 * the credential address as an ed25519 key and therefore throws
 * `invalid version byte. expected 48, got 16` for a `C...` payer) cannot be used.
 */

/** Tag identifying the `zk-v1` signature layout, matching {@link NulthAuthSignature.nulth}. */
export const NULTH_SIGNATURE_VERSION = 'zk-v1'

/**
 * Global-registry symbol set on signers produced by {@link createNulthSigner}, so
 * an x402 client can pick the Nulth scheme without importing the signer factory.
 * Registered globally because `@routedock/routedock` ships its own inlined copy of
 * the signer (see #575); two copies of the same symbol must still compare equal.
 */
export const NULTH_SIGNER_MARKER = Symbol.for('routedock.nulth.signer')

/** Anything carrying the marker is payer-side Nulth: contract account + proof signature. */
export interface NulthSignerMarker {
  readonly [NULTH_SIGNER_MARKER]: typeof NULTH_SIGNATURE_VERSION
}

export function isNulthStellarSigner(signer: object): boolean {
  return (signer as Partial<NulthSignerMarker>)[NULTH_SIGNER_MARKER] === NULTH_SIGNATURE_VERSION
}

const SCVAL_TYPES = {
  nulth: ['symbol', 'string'],
  version: ['symbol', 'u32'],
  proof: ['symbol', 'bytes'],
  auth_digest: ['symbol', 'string'],
  allowlist_commitment: ['symbol', 'string'],
  cap_commitment: ['symbol', 'string'],
  payee_hash: ['symbol', 'string'],
  amount_stroops: ['symbol', 'i128'],
  day_bucket: ['symbol', 'u64'],
} as const

/**
 * Encode a Nulth proof as the `SorobanAddressCredentials.signature` a Nulth
 * account contract's `__check_auth` reads: `vec[map]`, the same shape Stellar uses
 * for account signatures (`vec[{public_key, signature}]`), with the proof fields
 * flattened into the map so the contract can map each one to a public input
 * without parsing JSON.
 */
export function nulthProofScVal(signature: NulthAuthSignature): xdr.ScVal {
  if (signature.nulth !== NULTH_SIGNATURE_VERSION) {
    throw new RangeError(`unsupported Nulth signature format ${String(signature.nulth)}`)
  }
  const { proof } = signature
  const inputs = proof.publicInputs

  return xdr.ScVal.scvVec([
    nativeToScVal(
      {
        nulth: signature.nulth,
        version: proof.version,
        proof: base64ToBytes(proof.proof),
        auth_digest: inputs.authDigest,
        allowlist_commitment: inputs.allowlistCommitment,
        cap_commitment: inputs.capCommitment,
        payee_hash: inputs.payeeHash,
        amount_stroops: BigInt(inputs.amountStroops),
        day_bucket: BigInt(inputs.dayBucket),
      },
      { type: SCVAL_TYPES },
    ),
  ])
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new TypeError(`Nulth signature field ${field} is not a string`)
  }
  return value
}

function requiredBytes(value: unknown, field: string): string {
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(`Nulth signature field ${field} is not bytes`)
  }
  return bytesToBase64(value)
}

function requiredNumber(value: unknown, field: string): number {
  const num = Number(value)
  if (!Number.isInteger(num)) {
    throw new TypeError(`Nulth signature field ${field} is not an integer`)
  }
  return num
}

/** The public inputs are decimal strings off-chain but integers in the ScVal. */
function requiredDecimal(value: unknown, field: string): string {
  if (typeof value === 'string') return value
  if (typeof value === 'bigint' || typeof value === 'number') return value.toString()
  throw new TypeError(`Nulth signature field ${field} is not a decimal value`)
}

/**
 * Decode a signature ScVal written by {@link nulthProofScVal}. A Nulth account
 * contract reads the same map; this is the client/provider-side mirror of that
 * read, used to prove a signed entry round-trips.
 */
export function decodeNulthProofScVal(signature: xdr.ScVal): NulthAuthSignature {
  if (signature.switch() !== xdr.ScValType.scvVec()) {
    throw new TypeError('Nulth signature is not a vec')
  }
  const entries = signature.vec()
  if (!entries || entries.length !== 1) {
    throw new TypeError(`Nulth signature vec must hold exactly one map, got ${entries?.length ?? 0}`)
  }
  const fields = scValToNative(entries[0]!) as Record<string, unknown>

  const nulth = requiredString(fields.nulth, 'nulth')
  if (nulth !== NULTH_SIGNATURE_VERSION) {
    throw new TypeError(`unsupported Nulth signature format ${nulth}`)
  }

  const proof: NulthProof = {
    version: requiredNumber(fields.version, 'version') as 1,
    proof: requiredBytes(fields.proof, 'proof'),
    publicInputs: {
      authDigest: requiredString(fields.auth_digest, 'auth_digest'),
      allowlistCommitment: requiredString(fields.allowlist_commitment, 'allowlist_commitment'),
      capCommitment: requiredString(fields.cap_commitment, 'cap_commitment'),
      payeeHash: requiredString(fields.payee_hash, 'payee_hash'),
      amountStroops: requiredDecimal(fields.amount_stroops, 'amount_stroops'),
      dayBucket: requiredDecimal(fields.day_bucket, 'day_bucket'),
    },
  }
  return { nulth: NULTH_SIGNATURE_VERSION, proof }
}

/**
 * Build the signature the Nulth account authorises: sign the authorization
 * preimage through the Nulth signer, which runs the off-chain policy checks and
 * returns the `zk-v1` envelope, then write the proof into the credentials.
 *
 * Mirrors stellar-base's `authorizeEntry` in the parts that matter — the preimage
 * is built identically, so the digest the proof binds is the one the network
 * recomputes — and replaces the ed25519 verification and `{public_key, signature}`
 * vec with {@link nulthProofScVal}. The parameter list matches
 * `typeof authorizeEntry` deliberately, so it can be handed to
 * `AssembledTransaction.signAuthEntries` as its `authorizeEntry` override.
 */
export async function nulthAuthorizeEntry(
  entry: xdr.SorobanAuthorizationEntry,
  signer: SigningCallback | Keypair,
  validUntilLedgerSeq: number,
  networkPassphrase?: string,
): Promise<xdr.SorobanAuthorizationEntry> {
  if (entry.credentials().switch() !== xdr.SorobanCredentialsType.sorobanCredentialsAddress()) {
    return entry
  }
  if (typeof signer !== 'function') {
    throw new TypeError(
      'nulthAuthorizeEntry needs a callback that returns the zk-v1 proof envelope; a Keypair can only produce an ed25519 signature',
    )
  }
  if (!networkPassphrase) {
    throw new TypeError('nulthAuthorizeEntry needs the network passphrase to build the preimage')
  }

  const clone = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR())
  const credentials = clone.credentials().address()
  const address = Address.fromScAddress(credentials.address()).toString()
  if (!address.startsWith('C')) {
    throw new TypeError(
      `nulthAuthorizeEntry signs Nulth contract accounts (C...) only, got ${address}`,
    )
  }

  credentials.signatureExpirationLedger(validUntilLedgerSeq)
  const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: hash(utf8ToBytes(networkPassphrase) as Parameters<typeof hash>[0]),
      nonce: credentials.nonce(),
      invocation: clone.rootInvocation(),
      signatureExpirationLedger: credentials.signatureExpirationLedger(),
    }),
  )

  const signed = await signer(preimage)
  credentials.signature(nulthProofScVal(decodeAuthSignature(envelopeBase64(signed))))
  return clone
}

/**
 * `SigningCallback` allows several byte containers (and an ed25519
 * `{ signature, publicKey }` pair). Only raw bytes carry a Nulth envelope.
 */
function envelopeBase64(signed: Awaited<ReturnType<SigningCallback>>): string {
  if (signed instanceof Uint8Array) return bytesToBase64(signed)
  if (signed instanceof ArrayBuffer) return bytesToBase64(new Uint8Array(signed))
  throw new TypeError('Nulth signing callback must return the zk-v1 envelope as bytes')
}
