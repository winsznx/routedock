/**
 * Unit tests for Ed25519 manifest signing and verification.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { Keypair } from '@stellar/stellar-sdk'
import { signManifest, verifyManifestSignature, manifestDigest } from '../manifest/sign.js'
import { RouteDockSignatureError } from '../errors.js'
import type { RouteDockManifest } from '../types.js'
import schema from '../schemas/routedock.schema.json' with { type: 'json' }

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
  sla: {
    uptime_30d_percent: 99.9,
    p95_latency_ms: 120,
    maintenance_windows: [{ cron: '0 2 * * 0', duration_minutes: 30 }],
  },
  endpoints: {
    price: {
      method: 'GET',
      path: '/price',
      headers: { accept: 'application/json' },
    },
  },
  tags: ['test'],
  capabilities: { streaming: ['sse'], webhooks: true },
}

const ajv = new Ajv()
addFormats(ajv)
const validateManifest = ajv.compile(schema)

describe('signManifest', () => {
  it('returns a manifest with a base64 signature field', () => {
    const signed = signManifest(baseManifest, keypair.secret())
    assert.ok(typeof signed.signature === 'string', 'signature should be a string')
    assert.ok(signed.signature.length > 0, 'signature should be non-empty')
    assert.equal(signed.signature_version, '2')
    // base64: length should be a multiple of 4 (or with padding)
    assert.doesNotThrow(() => Buffer.from(signed.signature!, 'base64'))
  })

  it('uses a schema-valid manifest fixture', () => {
    assert.equal(validateManifest(baseManifest), true, JSON.stringify(validateManifest.errors))
  })

  it('does not mutate the original manifest', () => {
    signManifest(baseManifest, keypair.secret())
    assert.equal(
      (baseManifest as RouteDockManifest & { signature?: string }).signature,
      undefined,
    )
  })

  it('produces a stable digest regardless of signature field presence', () => {
    const withSig = { ...baseManifest, signature_version: '2' as const, signature: 'somesig' }
    const withoutSig = { ...baseManifest, signature_version: '2' as const }
    const d1 = manifestDigest(withSig as RouteDockManifest)
    const d2 = manifestDigest(withoutSig)
    assert.equal(d1.toString('hex'), d2.toString('hex'))
  })

  it('produces the same digest regardless of nested object insertion order', () => {
    const reordered = {
      ...baseManifest,
      pricing: { x402: { per: 'request' as const, amount: '0.001' } },
      endpoints: {
        price: {
          headers: { accept: 'application/json' },
          path: '/price',
          method: 'GET',
        },
      },
    }
    assert.equal(
      manifestDigest(baseManifest).toString('hex'),
      manifestDigest(reordered).toString('hex'),
    )
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

  it('rejects legacy signatures without an explicit safe signature version', () => {
    const signed = signManifest(baseManifest, keypair.secret())
    const { signature_version: _omit, ...legacy } = signed
    assert.throws(
      () => verifyManifestSignature(legacy),
      (err) => err instanceof RouteDockSignatureError && err.message.includes('legacy signatures'),
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

  const nestedTamperingCases: Array<[string, (manifest: ReturnType<typeof signManifest>) => RouteDockManifest]> = [
    ['pricing.x402.amount', (manifest) => ({
      ...manifest,
      pricing: { ...manifest.pricing, x402: { ...manifest.pricing.x402!, amount: '999' } },
    })],
    ['pricing.x402.payee', (manifest) => ({
      ...manifest,
      pricing: {
        ...manifest.pricing,
        x402: { ...manifest.pricing.x402!, payee: otherKeypair.publicKey() },
      },
    })],
    ['endpoints.price.path', (manifest) => ({
      ...manifest,
      endpoints: { ...manifest.endpoints, price: { ...manifest.endpoints.price!, path: '/evil' } },
    })],
    ['sla.maintenance_windows', (manifest) => ({
      ...manifest,
      sla: {
        ...manifest.sla!,
        maintenance_windows: [{ cron: '0 * * * *', duration_minutes: 600 }],
      },
    })],
    ['capabilities.streaming', (manifest) => ({
      ...manifest,
      capabilities: { ...manifest.capabilities, streaming: ['websocket'] },
    })],
  ]

  for (const [field, tamper] of nestedTamperingCases) {
    it(`rejects tampering with ${field}`, () => {
      const signed = signManifest(baseManifest, keypair.secret())
      assert.throws(
        () => verifyManifestSignature(tamper(signed)),
        (err) => err instanceof RouteDockSignatureError,
      )
    })
  }

  it('rejects tampering with mpp-session channel configuration', () => {
    const sessionManifest: RouteDockManifest = {
      ...baseManifest,
      modes: ['mpp-session'],
      pricing: {
        'mpp-session': {
          rate: '0.0001',
          per: 'voucher',
          channel_factory: 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH',
          min_deposit: '0.10',
          refund_waiting_period_ledgers: 17280,
        },
      },
    }
    const signed = signManifest(sessionManifest, keypair.secret())
    const tampered = {
      ...signed,
      pricing: {
        'mpp-session': {
          ...signed.pricing['mpp-session']!,
          channel_factory: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM',
        },
      },
    }
    assert.throws(
      () => verifyManifestSignature(tampered),
      (err) => err instanceof RouteDockSignatureError,
    )
  })

  it('passes when the manifest payee matches the expectedPayee trust anchor', () => {
    const signed = signManifest(baseManifest, keypair.secret())
    assert.doesNotThrow(() => verifyManifestSignature(signed, keypair.publicKey()))
  })

  it('throws when the manifest payee does not match expectedPayee', () => {
    const signed = signManifest(baseManifest, keypair.secret())
    assert.throws(
      () => verifyManifestSignature(signed, otherKeypair.publicKey()),
      (err) =>
        err instanceof RouteDockSignatureError &&
        err.message.includes('does not match expected payee'),
    )
  })

  it('rejects a substituted self-signed manifest even when its signature is valid', () => {
    // Attacker serves a manifest signed by THEIR key. Without a trust anchor it
    // verifies fine; bound to the trusted payee it must be rejected.
    const substituted = signManifest(
      { ...baseManifest, payee: otherKeypair.publicKey() },
      otherKeypair.secret(),
    )
    assert.doesNotThrow(() => verifyManifestSignature(substituted))
    assert.throws(
      () => verifyManifestSignature(substituted, keypair.publicKey()),
      (err) => err instanceof RouteDockSignatureError,
    )
  })
})
