import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { resolvePayee } from '../payee.js'
import type { RouteDockManifest } from '../../types.js'

const TOP_LEVEL = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATOP'
const X402_PAYEE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAX402'
const CHARGE_PAYEE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACHARGE'

function makeManifest(pricing: RouteDockManifest['pricing']): RouteDockManifest {
  return {
    routedock: '1.0',
    name: 'Test Service',
    description: 'Unit test provider',
    modes: ['x402', 'mpp-charge'],
    network: 'testnet',
    asset: 'USDC',
    asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    payee: TOP_LEVEL,
    pricing,
    endpoints: { price: 'GET /price' },
    tags: ['test'],
  }
}

describe('resolvePayee', () => {
  it('falls back to top-level payee when no override is set', () => {
    const manifest = makeManifest({
      x402: { amount: '0.001', per: 'request' },
      'mpp-charge': { amount: '0.0008', per: 'request' },
    })
    assert.equal(resolvePayee(manifest, 'x402'), TOP_LEVEL)
    assert.equal(resolvePayee(manifest, 'mpp-charge'), TOP_LEVEL)
  })

  it('uses the per-mode override when present', () => {
    const manifest = makeManifest({
      x402: { amount: '0.001', per: 'request', payee: X402_PAYEE },
      'mpp-charge': { amount: '0.0008', per: 'request', payee: CHARGE_PAYEE },
    })
    assert.equal(resolvePayee(manifest, 'x402'), X402_PAYEE)
    assert.equal(resolvePayee(manifest, 'mpp-charge'), CHARGE_PAYEE)
  })

  it('resolves each mode independently — one override does not affect the other', () => {
    const manifest = makeManifest({
      x402: { amount: '0.001', per: 'request', payee: X402_PAYEE },
      'mpp-charge': { amount: '0.0008', per: 'request' },
    })
    assert.equal(resolvePayee(manifest, 'x402'), X402_PAYEE)
    assert.equal(resolvePayee(manifest, 'mpp-charge'), TOP_LEVEL)
  })

  it('falls back when the mode is absent from pricing', () => {
    const manifest = makeManifest({
      x402: { amount: '0.001', per: 'request' },
    })
    assert.equal(resolvePayee(manifest, 'mpp-charge'), TOP_LEVEL)
  })
})
