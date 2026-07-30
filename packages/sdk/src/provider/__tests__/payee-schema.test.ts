import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import Ajv from 'ajv'
import schema from '../../schemas/routedock.schema.json' with { type: 'json' }

const ajv = new Ajv()
const validate = ajv.compile(schema)

const PAYEE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATOP'
const X402_PAYEE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAX402'

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
    endpoints: { price: 'GET /price' },
    tags: ['test'],
  }
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

  it('rejects a per-mode payee on mpp-session (override not supported there)', () => {
    const m = baseManifest()
    ;(m.modes as string[]).push('mpp-session')
    const pricing = m.pricing as Record<string, Record<string, unknown>>
    pricing['mpp-session'] = {
      rate: '0.0001',
      per: 'voucher',
      channel_contract: 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH',
      min_deposit: '0.10',
      refund_waiting_period_ledgers: 17280,
      payee: PAYEE,
    }
    assert.equal(validate(m), false)
  })
})
