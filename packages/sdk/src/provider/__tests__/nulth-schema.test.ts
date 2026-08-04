import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import schema from '../../schemas/routedock.schema.json' with { type: 'json' }

const ajv = new Ajv()
addFormats(ajv)
const validate = ajv.compile(schema)

const NULTH_ACCOUNT = 'CAX5IDLC2XHGQSEA2YN3LPLZ7EXLMRXYX3HFJGKFXS6B7OQXBKWO44LT'

function baseManifest(): Record<string, unknown> {
  return {
    routedock: '1.0',
    name: 'Nulth Test Provider',
    description: 'Schema regression test for Nulth-enabled manifests',
    modes: ['x402'],
    network: 'testnet',
    asset: 'USDC',
    asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    payee: 'GDHLJWBM6Z2Y4KF6Z4JAFIUUO2KAXAJ6MAIUK2XMGBQ7ZUUZ7HFPW2BK',
    pricing: {
      x402: {
        amount: '0.001',
        per: 'request',
        facilitator: 'https://channels.openzeppelin.com/x402/testnet',
      },
    },
    endpoints: {
      price: {
        method: 'GET',
        path: '/price',
      },
    },
    tags: ['test'],
  }
}

describe('routedock.schema — Nulth vault fields', () => {
  it('accepts a Nulth-enabled manifest', () => {
    const manifest = {
      ...baseManifest(),
      vault: 'nulth',
      nulth_account: NULTH_ACCOUNT,
    }

    assert.equal(validate(manifest), true, JSON.stringify(validate.errors))
  })

  it('rejects an unsupported vault mode', () => {
    const manifest = {
      ...baseManifest(),
      vault: 'unsupported-vault',
      nulth_account: NULTH_ACCOUNT,
    }

    assert.equal(validate(manifest), false)
  })
})
