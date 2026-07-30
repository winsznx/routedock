/**
 * Ed25519 manifest signing and verification.
 *
 * The canonical message is the SHA-256 hash of the manifest JSON with the
 * `signature` field omitted and keys sorted deterministically (JSON.stringify
 * of the sorted-key object). The payee Stellar keypair signs this hash.
 *
 * Clients call `verifyManifestSignature` before trusting any routing field.
 * Providers call `signManifest` once at startup to embed the signature.
 */

import { createHash } from 'node:crypto'
import { Keypair } from '@stellar/stellar-sdk'
import type { RouteDockManifest } from '../types.js'
import { RouteDockSignatureError } from '../errors.js'

/** Produce the canonical SHA-256 digest of the manifest (signature field excluded). */
export function manifestDigest(manifest: RouteDockManifest): Buffer {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { signature: _omit, ...rest } = manifest as RouteDockManifest & { signature?: string }
  const canonical = JSON.stringify(rest, Object.keys(rest).sort())
  return createHash('sha256').update(canonical, 'utf8').digest()
}

/**
 * Sign a manifest with the payee's Stellar secret key.
 * Returns a new manifest object with the `signature` field populated.
 */
export function signManifest(
  manifest: RouteDockManifest,
  payeeSecretKey: string,
): RouteDockManifest & { signature: string } {
  const keypair = Keypair.fromSecret(payeeSecretKey)
  const digest = manifestDigest(manifest)
  const sig = keypair.sign(digest)
  return { ...manifest, signature: Buffer.from(sig).toString('base64') }
}

/**
 * Verify the manifest's Ed25519 signature.
 * Throws `RouteDockSignatureError` if the signature is missing or invalid.
 */
export function verifyManifestSignature(manifest: RouteDockManifest & { signature?: string }): void {
  if (!manifest.signature) {
    throw new RouteDockSignatureError(
      'Manifest is missing a signature field — cannot verify payee authenticity',
    )
  }

  const keypair = Keypair.fromPublicKey(manifest.payee)
  const digest = manifestDigest(manifest)
  let sigBytes: Buffer
  try {
    sigBytes = Buffer.from(manifest.signature, 'base64')
  } catch {
    throw new RouteDockSignatureError('Manifest signature is not valid base64')
  }

  const valid = keypair.verify(digest, sigBytes)
  if (!valid) {
    throw new RouteDockSignatureError(
      `Manifest signature verification failed for payee ${manifest.payee}`,
    )
  }
}
