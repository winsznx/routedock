/**
 * Unit tests for Ed25519 manifest signing and verification.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import { signManifest, verifyManifestSignature, manifestDigest } from '../manifest/sign.js'
import { RouteDockSignatureError } from '../errors.js'
import type { RouteDockManifest } from '../types.js'

const keypair = Keypair.random()
const otherKeypair = Keypair.random()

const baseManifest: RouteDockManifest = {
  routedock: '1.0',
  name: 'Test Provider',
  description: 'Unit test provider',
  modes: ['x402'],
  network: 'testnet',
  asset: 'USDC',
  asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
  payee: keypair.publicKey(),
  pricing: { x402: { amount: '0.001', per: 'request' } },
  endpoints: { price: 'GET /price' },
  tags: ['test'],
}

describe('signManifest', () => {
  it('returns a manifest with a base64 signature field', () => {
    const signed = signManifest(baseManifest, keypair.secret())
    assert.ok(typeof signed.signature === 'string', 'signature should be a string')
    assert.ok(signed.signature.length > 0, 'signature should be non-empty')
    // base64: length should be a multiple of 4 (or with padding)
    assert.doesNotThrow(() => Buffer.from(signed.signature!, 'base64'))
  })

  it('does not mutate the original manifest', () => {
    signManifest(baseManifest, keypair.secret())
    assert.equal(
      (baseManifest as RouteDockManifest & { signature?: string }).signature,
      undefined,
    )
  })

  it('produces a stable digest regardless of signature field presence', () => {
    const withSig = { ...baseManifest, signature: 'somesig' }
    const withoutSig = { ...baseManifest }
    const d1 = manifestDigest(withSig as RouteDockManifest)
    const d2 = manifestDigest(withoutSig)
    assert.equal(d1.toString('hex'), d2.toString('hex'))
  })
})

describe('verifyManifestSignature', () => {
  it('passes for a correctly signed manifest', () => {
    const signed = signManifest(baseManifest, keypair.secret())
    assert.doesNotThrow(() => verifyManifestSignature(signed))
  })

  it('throws RouteDockSignatureError when signature field is missing', () => {
    assert.throws(
      () => verifyManifestSignature(baseManifest),
      (err) => err instanceof RouteDockSignatureError && err.message.includes('missing'),
    )
  })

  it('throws RouteDockSignatureError when signature is forged', () => {
    const signed = signManifest(baseManifest, keypair.secret())
    const forged = { ...signed, signature: signManifest({ ...baseManifest, payee: keypair.publicKey() }, otherKeypair.secret()).signature }
    assert.throws(
      () => verifyManifestSignature(forged),
      (err) => err instanceof RouteDockSignatureError,
    )
  })

  it('throws RouteDockSignatureError when payee field is tampered', () => {
    const signed = signManifest(baseManifest, keypair.secret())
    const tampered = { ...signed, payee: otherKeypair.publicKey() }
    assert.throws(
      () => verifyManifestSignature(tampered),
      (err) => err instanceof RouteDockSignatureError,
    )
  })

  it('throws RouteDockSignatureError when any manifest field is tampered', () => {
    const signed = signManifest(baseManifest, keypair.secret())
    const tampered = { ...signed, name: 'Evil Provider' }
    assert.throws(
      () => verifyManifestSignature(tampered),
      (err) => err instanceof RouteDockSignatureError,
    )
  })
})
