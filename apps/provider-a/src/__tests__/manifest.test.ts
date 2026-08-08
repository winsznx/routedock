import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import schema from '@routedock/routedock/schema'
import { buildManifest, TESTNET_USDC_CONTRACT } from '../manifest.js'

/**
 * The Express server validated its manifest against the schema at startup and
 * called process.exit(1) on failure. Workers have no startup hook and Ajv
 * compiles validators with `new Function`, which the Workers runtime rejects,
 * so the check lives here instead — it fails the build rather than the deploy.
 */
describe('provider-a manifest', () => {
  const ajv = new Ajv()
  addFormats(ajv)
  const validate = ajv.compile(schema)

  it('produces a schema-valid testnet manifest', () => {
    // #given
    const manifest = buildManifest({
      network: 'testnet',
      payee: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      assetContract: TESTNET_USDC_CONTRACT,
    })

    // #when
    const valid = validate(manifest)

    // #then
    assert.equal(valid, true, JSON.stringify(validate.errors, null, 2))
  })

  it('produces a schema-valid mainnet manifest', () => {
    // #given
    const manifest = buildManifest({
      network: 'mainnet',
      payee: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      assetContract: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
    })

    // #when
    const valid = validate(manifest)

    // #then
    assert.equal(valid, true, JSON.stringify(validate.errors, null, 2))
  })

  it('points the x402 facilitator at the testnet path only on testnet', () => {
    // #given
    const testnet = buildManifest({
      network: 'testnet',
      payee: 'G_TEST',
      assetContract: TESTNET_USDC_CONTRACT,
    })
    const mainnet = buildManifest({
      network: 'mainnet',
      payee: 'G_MAIN',
      assetContract: 'C_MAIN',
    })

    // #then
    assert.match(testnet.pricing.x402!.facilitator!, /\/x402\/testnet$/)
    assert.match(mainnet.pricing.x402!.facilitator!, /\/x402$/)
  })
})
