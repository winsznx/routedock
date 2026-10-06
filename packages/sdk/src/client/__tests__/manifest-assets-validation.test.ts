import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Validator, type Schema } from '@cfworker/json-schema'
import { assertManifestValid } from '../ModeRouter.js'
import { RouteDockManifestError } from '../../errors.js'
import type { RouteDockManifest } from '../../types.js'
import schema from '../../schemas/routedock.schema.json' with { type: 'json' }

const validator = new Validator(schema as unknown as Schema, '7')

const validBaseManifest: RouteDockManifest = {
  routedock: '1.0',
  name: 'Test Provider',
  description: 'Provider validation test',
  modes: ['x402', 'mpp-charge'],
  network: 'testnet',
  asset: 'USDC',
  asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
  payee: 'GDTESTPAYEEADDRESS0000000000000000000000000000000000000000',
  pricing: {
    x402: { amount: '0.001', per: 'request' },
    'mpp-charge': { amount: '0.0008', per: 'request' },
  },
  endpoints: {
    price: { method: 'GET', path: '/price' },
  },
  tags: ['test'],
}

describe('Manifest schema & semantic validation — assets support', () => {
  it('validates a manifest without assets successfully', () => {
    const result = validator.validate(validBaseManifest)
    assert.equal(result.valid, true, JSON.stringify(result.errors))
    assert.doesNotThrow(() => assertManifestValid(validBaseManifest))
  })

  it('validates a manifest with conforming assets successfully', () => {
    const manifestWithAssets: RouteDockManifest = {
      ...validBaseManifest,
      assets: [
        {
          asset: 'USDC',
          asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
          modes: ['x402'],
          endpoints: ['price'],
        },
        {
          asset: 'XLM',
          asset_contract: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
          modes: ['mpp-charge'],
        },
      ],
    }

    const result = validator.validate(manifestWithAssets)
    assert.equal(result.valid, true, JSON.stringify(result.errors))
    assert.doesNotThrow(() => assertManifestValid(manifestWithAssets))
  })

  it('rejects a manifest when assets[0].asset mismatches root asset', () => {
    const mismatched: RouteDockManifest = {
      ...validBaseManifest,
      asset: 'USDC',
      asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      assets: [
        {
          asset: 'XLM', // mismatch!
          asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
        },
      ],
    }

    assert.throws(
      () => assertManifestValid(mismatched),
      (err) =>
        err instanceof RouteDockManifestError &&
        err.message.includes('assets[0] (XLM:CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA) must match root asset fields (USDC:CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA)'),
    )
  })

  it('rejects a manifest when assets[0].asset_contract mismatches root asset_contract', () => {
    const mismatched: RouteDockManifest = {
      ...validBaseManifest,
      asset: 'USDC',
      asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      assets: [
        {
          asset: 'USDC',
          asset_contract: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC', // mismatch!
        },
      ],
    }

    assert.throws(
      () => assertManifestValid(mismatched),
      (err) =>
        err instanceof RouteDockManifestError &&
        err.message.includes('must match root asset fields'),
    )
  })

  it('rejects empty assets array in schema and semantic validation', () => {
    const emptyAssets = {
      ...validBaseManifest,
      assets: [],
    }

    const result = validator.validate(emptyAssets)
    assert.equal(result.valid, false, 'Schema should reject empty assets array (minItems: 1)')

    assert.throws(
      () => assertManifestValid(emptyAssets as unknown as RouteDockManifest),
      (err) => err instanceof RouteDockManifestError && err.message.includes('assets must be a non-empty array'),
    )
  })

  it('rejects asset missing asset_contract in schema validation', () => {
    const missingContract = {
      ...validBaseManifest,
      assets: [
        {
          asset: 'USDC',
          // missing asset_contract
        },
      ],
    }

    const result = validator.validate(missingContract)
    assert.equal(result.valid, false, 'Schema should reject AssetConfig without asset_contract')
  })

  it('rejects additional properties in AssetConfig', () => {
    const extraProp = {
      ...validBaseManifest,
      assets: [
        {
          asset: 'USDC',
          asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
          unexpected_extra_property: true,
        },
      ],
    }

    const result = validator.validate(extraProp)
    assert.equal(result.valid, false, 'Schema should reject additional properties in AssetConfig')
  })

  it('rejects invalid payment modes in AssetConfig.modes', () => {
    const invalidMode = {
      ...validBaseManifest,
      assets: [
        {
          asset: 'USDC',
          asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
          modes: ['invalid-mode'],
        },
      ],
    }

    const result = validator.validate(invalidMode)
    assert.equal(result.valid, false, 'Schema should reject invalid payment modes in AssetConfig.modes')
  })
})
