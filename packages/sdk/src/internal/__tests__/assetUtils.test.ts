import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  normalizeManifestAssets,
  getEligibleAssets,
  selectAsset,
  isAssetEligible,
  resolveAssetContract,
} from '../assetUtils.js'
import { RouteDockManifestError } from '../../errors.js'
import type { RouteDockManifest } from '../../types.js'

const legacyManifest: RouteDockManifest = {
  routedock: '1.0',
  name: 'Legacy Service',
  description: 'Single-asset provider',
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
    quote: { method: 'POST', path: '/quote' },
  },
  tags: ['test'],
}

const multiAssetManifest: RouteDockManifest = {
  routedock: '1.0',
  name: 'Multi-Asset Service',
  description: 'Provider supporting USDC and XLM',
  modes: ['x402', 'mpp-charge', 'mpp-session'],
  network: 'testnet',
  asset: 'USDC',
  asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
  assets: [
    {
      asset: 'USDC',
      asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      modes: ['x402', 'mpp-session'],
      endpoints: ['price'],
    },
    {
      asset: 'XLM',
      asset_contract: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
      modes: ['mpp-charge'],
      endpoints: ['quote'],
    },
    {
      asset: 'EURC',
      asset_contract: 'CEURCSACADDRESS00000000000000000000000000000000000000000000',
      // available for all modes and endpoints
    },
  ],
  payee: 'GDTESTPAYEEADDRESS0000000000000000000000000000000000000000',
  pricing: {
    x402: { amount: '0.001', per: 'request' },
    'mpp-charge': { amount: '0.0008', per: 'request' },
    'mpp-session': {
      rate: '0.0001',
      per: 'voucher',
      channel_factory: 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH',
      min_deposit: '0.10',
      refund_waiting_period_ledgers: 17280,
    },
  },
  endpoints: {
    price: { method: 'GET', path: '/price' },
    quote: { method: 'POST', path: '/quote' },
  },
  tags: ['test'],
}

describe('normalizeManifestAssets', () => {
  it('normalizes a legacy single-asset manifest to an assets array', () => {
    const assets = normalizeManifestAssets(legacyManifest)
    assert.equal(assets.length, 1)
    assert.deepEqual(assets[0], {
      asset: 'USDC',
      asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    })
  })

  it('returns existing assets array when present in manifest', () => {
    const assets = normalizeManifestAssets(multiAssetManifest)
    assert.equal(assets.length, 3)
    assert.equal(assets[0]?.asset, 'USDC')
    assert.equal(assets[1]?.asset, 'XLM')
    assert.equal(assets[2]?.asset, 'EURC')
  })

  it('throws RouteDockManifestError when neither assets nor root fields are defined', () => {
    const malformed = { ...legacyManifest, asset: undefined, asset_contract: undefined } as unknown as RouteDockManifest
    assert.throws(
      () => normalizeManifestAssets(malformed),
      (err) => err instanceof RouteDockManifestError,
    )
  })
})

describe('getEligibleAssets', () => {
  it('returns single asset for legacy manifest regardless of mode when unscoped', () => {
    const x402Assets = getEligibleAssets(legacyManifest, 'x402')
    assert.equal(x402Assets.length, 1)
    assert.equal(x402Assets[0]?.asset, 'USDC')

    const chargeAssets = getEligibleAssets(legacyManifest, 'mpp-charge')
    assert.equal(chargeAssets.length, 1)
    assert.equal(chargeAssets[0]?.asset, 'USDC')
  })

  it('filters assets by mode correctly', () => {
    const chargeAssets = getEligibleAssets(multiAssetManifest, 'mpp-charge')
    // XLM (scoped to mpp-charge) and EURC (unscoped) should be eligible
    const assetNames = chargeAssets.map((a) => a.asset)
    assert.deepEqual(assetNames, ['XLM', 'EURC'])

    const x402Assets = getEligibleAssets(multiAssetManifest, 'x402')
    // USDC (scoped to x402, mpp-session) and EURC (unscoped) should be eligible
    const x402Names = x402Assets.map((a) => a.asset)
    assert.deepEqual(x402Names, ['USDC', 'EURC'])
  })

  it('filters assets by endpoint name', () => {
    const priceChargeAssets = getEligibleAssets(multiAssetManifest, 'mpp-charge', 'price')
    // For price endpoint: XLM is scoped to 'quote' (not 'price'), USDC is scoped to x402/mpp-session (not mpp-charge)
    // EURC has no endpoint or mode restriction, so it matches
    assert.deepEqual(priceChargeAssets.map((a) => a.asset), ['EURC'])

    const quoteChargeAssets = getEligibleAssets(multiAssetManifest, 'mpp-charge', 'quote')
    // For quote endpoint: XLM matches, EURC matches
    assert.deepEqual(quoteChargeAssets.map((a) => a.asset), ['XLM', 'EURC'])
  })

  it('filters assets by endpoint path or full URL', () => {
    const pathAssets = getEligibleAssets(multiAssetManifest, 'x402', '/price')
    assert.ok(pathAssets.some((a) => a.asset === 'USDC'))

    const urlAssets = getEligibleAssets(multiAssetManifest, 'x402', 'https://example.com/price')
    assert.ok(urlAssets.some((a) => a.asset === 'USDC'))
  })

  it('returns empty array when no assets are eligible for mode', () => {
    const noModeManifest: RouteDockManifest = {
      ...multiAssetManifest,
      assets: [
        {
          asset: 'USDC',
          asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
          modes: ['x402'],
        },
      ],
    }
    const eligible = getEligibleAssets(noModeManifest, 'mpp-charge')
    assert.equal(eligible.length, 0)
  })
})

describe('selectAsset', () => {
  it('returns first eligible asset for mode', () => {
    const asset = selectAsset(multiAssetManifest, 'mpp-charge')
    assert.equal(asset.asset, 'XLM')
    assert.equal(asset.asset_contract, 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC')
  })

  it('throws RouteDockManifestError when no asset is eligible', () => {
    const singleModeManifest: RouteDockManifest = {
      ...multiAssetManifest,
      assets: [
        {
          asset: 'USDC',
          asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
          modes: ['x402'],
        },
      ],
    }
    assert.throws(
      () => selectAsset(singleModeManifest, 'mpp-charge'),
      (err) => err instanceof RouteDockManifestError && err.message.includes("No eligible assets found for mode 'mpp-charge'"),
    )
  })
})

describe('isAssetEligible', () => {
  it('checks asset eligibility by ticker symbol and contract address', () => {
    assert.equal(isAssetEligible(multiAssetManifest, 'XLM', 'mpp-charge'), true)
    assert.equal(
      isAssetEligible(multiAssetManifest, 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC', 'mpp-charge'),
      true,
    )
    assert.equal(isAssetEligible(multiAssetManifest, 'USDC', 'mpp-charge'), false)
    assert.equal(isAssetEligible(multiAssetManifest, 'UNKNOWN', 'mpp-charge'), false)
  })
})

describe('resolveAssetContract', () => {
  it('resolves contract by mode and endpoint in multi-asset manifest', () => {
    assert.equal(
      resolveAssetContract(multiAssetManifest, 'x402', '/price'),
      'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    )
    assert.equal(
      resolveAssetContract(multiAssetManifest, 'mpp-charge', '/quote'),
      'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
    )
  })

  it('falls back to root asset_contract or explicitContract for legacy manifest', () => {
    assert.equal(
      resolveAssetContract(legacyManifest, 'x402', '/price'),
      'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    )
    assert.equal(
      resolveAssetContract(legacyManifest, 'x402', '/price', 'CUSTOM_OVERRIDE_CONTRACT'),
      'CUSTOM_OVERRIDE_CONTRACT',
    )
  })
})
