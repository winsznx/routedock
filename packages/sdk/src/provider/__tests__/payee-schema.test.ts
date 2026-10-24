import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import schema from '../../schemas/routedock.schema.json' with { type: 'json' }

const ajv = new Ajv()
addFormats(ajv)
const validate = ajv.compile(schema)

const PAYEE = 'GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR'
const X402_PAYEE = 'GCATS5YOVB6ROX2WUNKGNQ2MP3GMXDMKSG2O4N5CLX3A6W4PZGZZI55U'
const CHANNEL_FACTORY = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'

/** Session modes share SessionPricingConfig, so both need the same coverage. */
const SESSION_MODES = ['mpp-session', 'mpp-session-ws'] as const

function baseManifest(): Record<string, unknown> {
  return {
    routedock: '1.0',
    name: 'Test Service',
    description: 'Unit test provider',
    modes: ['x402', 'mpp-charge'],
    network: 'testnet',
    asset: 'USDC',
    asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    payee: PAYEE,
    pricing: {
      x402: { amount: '0.001', per: 'request' },
      'mpp-charge': { amount: '0.0008', per: 'request' },
    },
    endpoints: { price: { method: 'GET', path: '/price' } },
    tags: ['test'],
  }
}

/** A valid SessionPricingConfig, minus the `payee` override the schema must refuse. */
function sessionPricing(): Record<string, unknown> {
  return {
    rate: '0.0001',
    per: 'voucher',
    channel_factory: CHANNEL_FACTORY,
    min_deposit: '0.10',
    refund_waiting_period_ledgers: 17280,
  }
}

function manifestWithSessionPricing(pricing: Record<string, unknown>, mode: string) {
  const m = baseManifest()
  ;(m.modes as string[]).push(mode)
  ;(m.pricing as Record<string, Record<string, unknown>>)[mode] = pricing
  return m
}

describe('routedock.schema — per-mode payee', () => {
  it('accepts a manifest without per-mode payee overrides', () => {
    assert.equal(validate(baseManifest()), true, JSON.stringify(validate.errors))
  })

  it('accepts a per-mode payee override on x402 and mpp-charge', () => {
    const m = baseManifest()
    const pricing = m.pricing as Record<string, Record<string, unknown>>
    pricing.x402!.payee = X402_PAYEE
    pricing['mpp-charge']!.payee = PAYEE
    assert.equal(validate(m), true, JSON.stringify(validate.errors))
  })

  it('rejects an unknown property inside a pricing config', () => {
    const m = baseManifest()
    const pricing = m.pricing as Record<string, Record<string, unknown>>
    pricing.x402!.payeee = X402_PAYEE // typo — must not be silently accepted
    assert.equal(validate(m), false)
  })

  for (const mode of SESSION_MODES) {
    it(`accepts valid ${mode} session pricing`, () => {
      const m = manifestWithSessionPricing(sessionPricing(), mode)
      assert.equal(validate(m), true, JSON.stringify(validate.errors))
    })

    it(`rejects a per-mode payee on ${mode} (override not supported there)`, () => {
      const m = manifestWithSessionPricing({ ...sessionPricing(), payee: PAYEE }, mode)
      assert.equal(validate(m), false, `${mode} must not accept a payee override`)

      // Pin the rejection to `payee` so the test cannot go red for an
      // unrelated schema reason and still pass.
      const error = validate.errors!.find(
        (entry) =>
          entry.keyword === 'additionalProperties' &&
          entry.instancePath === `/pricing/${mode}` &&
          entry.params!.additionalProperty === 'payee',
      )
      assert.ok(
        error,
        `expected an additionalProperties error for payee at /pricing/${mode}, got ${JSON.stringify(validate.errors)}`,
      )
    })
  }
})
