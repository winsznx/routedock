import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import schema from '@routedock/routedock/schema'
import { buildManifest, TESTNET_USDC_CONTRACT } from '../manifest.js'

const CHANNEL = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'

describe('provider-b manifest', () => {
  const ajv = new Ajv()
  addFormats(ajv)
  const validate = ajv.compile(schema)

  it('produces a schema-valid testnet manifest', () => {
    // #given
    const manifest = buildManifest({
      network: 'testnet',
      payee: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      assetContract: TESTNET_USDC_CONTRACT,
      channelContract: CHANNEL,
    })

    // #when
    const valid = validate(manifest)

    // #then
    assert.equal(valid, true, JSON.stringify(validate.errors, null, 2))
  })

  it('carries the channel factory through to mpp-session and mpp-session-ws pricing', () => {
    // #given
    const manifest = buildManifest({
      network: 'testnet',
      payee: 'G_TEST',
      assetContract: TESTNET_USDC_CONTRACT,
      channelContract: CHANNEL,
    })

    // #then
    assert.deepEqual(manifest.modes, ['mpp-session', 'mpp-session-ws'])
    assert.equal(manifest.pricing['mpp-session']!.channel_factory, CHANNEL)
    assert.equal(manifest.pricing['mpp-session-ws']!.channel_factory, CHANNEL)
    assert.equal(manifest.pricing['mpp-session-ws']!.rate, '0.0001')
  })

  it('does not advertise sse or realtime, which the endpoint never served', () => {
    // #given — MppSessionClient.stream() issues one request per voucher and
    // calls resp.json(); there is no event stream to advertise.
    const manifest = buildManifest({
      network: 'testnet',
      payee: 'G_TEST',
      assetContract: TESTNET_USDC_CONTRACT,
      channelContract: CHANNEL,
    })

    // #then
    assert.equal(manifest.tags.includes('sse'), false)
    assert.equal(manifest.tags.includes('realtime'), false)
    assert.equal(manifest.endpoints['stream']!.path, '/stream/orderbook')
  })
})
