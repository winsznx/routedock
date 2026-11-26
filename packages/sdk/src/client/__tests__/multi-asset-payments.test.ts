import assert from 'node:assert/strict'
import { beforeEach, describe, it, mock } from 'node:test'
import { Horizon, Keypair } from '@stellar/stellar-sdk'
import { x402HTTPClient } from '@x402/core/client'
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http'
import type { PaymentRequirements } from '@x402/core/types'
import { Receipt } from 'mppx'
import { signManifest } from '../../manifest/sign.js'
import type { RouteDockManifest } from '../../types.js'
import { RouteDockNoSupportedModeError, RouteDockPolicyRejectError } from '../../errors.js'

const BASE_URL = 'https://multi-asset-payment.test'
const USDC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const XLM = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
const USDC_ISSUER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
const PAYEE = Keypair.random()
let challengeCurrency = XLM
let credentialCalls = 0

type OnChallenge = (
  challenge: { request: Record<string, unknown> },
  helpers: { createCredential: () => Promise<string> },
) => Promise<string | undefined>

mock.module('mppx/client', {
  namedExports: {
    Mppx: {
      create: (options: { onChallenge: OnChallenge }) => ({
        fetch: async (url: string, init?: RequestInit) => {
          const credential = await options.onChallenge({
            request: {
              amount: '8000',
              currency: challengeCurrency,
              recipient: PAYEE.publicKey(),
              methodDetails: { network: 'stellar:testnet' },
            },
          }, {
            createCredential: async () => {
              credentialCalls++
              return 'Payment scoped-asset-credential'
            },
          })
          const headers = new Headers(init?.headers)
          if (credential) headers.set('Authorization', credential)
          return globalThis.fetch(url, { ...init, headers })
        },
        rawFetch: (url: string, init?: RequestInit) => globalThis.fetch(url, init),
      }),
    },
  },
})

mock.module('@stellar/mpp/charge/client', {
  namedExports: {
    stellar: { charge: () => ({ name: 'stellar/charge', intent: 'charge' }) },
  },
})

const { RouteDockClient } = await import('../RouteDockClient.js')
const { invalidateManifest, selectMode } = await import('../ModeRouter.js')

function makeManifest(): RouteDockManifest {
  return signManifest({
    routedock: '1.0',
    name: 'Scoped asset payment fixture',
    description: 'USDC inference and XLM lookup',
    network: 'testnet',
    asset: 'USDC',
    asset_contract: USDC,
    modes: ['x402', 'mpp-charge'],
    assets: [
      { asset: 'USDC', asset_contract: USDC, modes: ['x402'], endpoints: ['inference'] },
      { asset: 'XLM', asset_contract: XLM, modes: ['mpp-charge'], endpoints: ['lookup'] },
    ],
    payee: PAYEE.publicKey(),
    pricing: {
      x402: { amount: '0.001', per: 'request', facilitator: 'https://facilitator.test' },
      'mpp-charge': { amount: '0.0008', per: 'request' },
    },
    endpoints: {
      inference: { method: 'POST', path: '/infer' },
      lookup: { method: 'GET', path: '/lookup' },
    },
    tags: ['test'],
  }, PAYEE.secret())
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', ...headers },
  })
}

function x402Challenge(): Response {
  return new Response(null, {
    status: 402,
    headers: {
      'X-Payment-Requirements': encodePaymentRequiredHeader({
        x402Version: 2,
        resource: { url: BASE_URL + '/infer' },
        accepts: [{
          scheme: 'exact',
          network: 'stellar:testnet',
          asset: USDC,
          amount: '10000',
          payTo: PAYEE.publicKey(),
          maxTimeoutSeconds: 60,
          extra: { areFeesSponsored: true },
        }],
      }),
    },
  })
}

function receipt(): string {
  return Receipt.serialize(Receipt.from({
    method: 'stellar',
    reference: 'scoped-xlm-settlement',
    status: 'success',
    timestamp: new Date().toISOString(),
  }))
}

function requestUrl(input: string | URL | Request): URL {
  return new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
}

beforeEach(() => {
  invalidateManifest(BASE_URL)
  challengeCurrency = XLM
  credentialCalls = 0
})

describe('RouteDockClient — endpoint-scoped multi-asset payments', () => {
  it('pays /infer with x402 by default even though mpp-charge is advertised', async (t) => {
    // #given the cheaper/default charge mode is scoped to a different endpoint
    const manifest = makeManifest()
    let paidRequests = 0
    t.mock.method(Horizon.Server.prototype, 'loadAccount', async () => ({
      balances: [{ asset_code: 'USDC', asset_type: 'credit_alphanum4', asset_issuer: USDC_ISSUER }],
    }))
    const signing = t.mock.method(x402HTTPClient.prototype, 'createPaymentPayload',
      async (required: { accepts: PaymentRequirements[] }) => ({
        x402Version: 2,
        accepted: required.accepts[0]!,
        payload: {},
      }))
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      if (requestUrl(input).pathname === '/.well-known/routedock.json') {
        return jsonResponse(manifest, { 'Cache-Control': 'no-store' })
      }
      assert.equal(requestUrl(input).pathname, '/infer')
      if (!new Headers(init?.headers).has('PAYMENT-SIGNATURE')) return x402Challenge()
      paidRequests++
      return jsonResponse({ endpoint: 'inference' }, {
        'X-Payment-Response': encodePaymentResponseHeader({
          success: true, transaction: 'scoped-usdc-settlement', network: 'stellar:testnet',
        }),
      })
    })
    // #when a caller pays without forcing a mode
    const result = await new RouteDockClient({ wallet: Keypair.random(), network: 'testnet' })
      .pay(BASE_URL + '/infer')
    // #then the eligible USDC challenge was signed and settled exactly once
    assert.equal(result.mode, 'x402')
    assert.equal(result.txHash, 'scoped-usdc-settlement')
    assert.equal(result.amount, '0.001')
    assert.equal(signing.mock.callCount(), 1)
    assert.equal(paidRequests, 1)
    assert.equal(credentialCalls, 0)
  })

  it('pays /lookup with the scoped XLM charge challenge', async (t) => {
    // #given the provider requests XLM while the root manifest asset is USDC
    const manifest = makeManifest()
    let paidRequests = 0
    t.mock.method(Horizon.Server.prototype, 'loadAccount', async () => ({
      balances: [{ asset_type: 'native', balance: '50.0000000' }],
    }))
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      if (requestUrl(input).pathname === '/.well-known/routedock.json') return jsonResponse(manifest)
      assert.equal(requestUrl(input).pathname, '/lookup')
      assert.equal(new Headers(init?.headers).get('Authorization'), 'Payment scoped-asset-credential')
      paidRequests++
      return jsonResponse({ endpoint: 'lookup' }, { 'Payment-Receipt': receipt() })
    })
    // #when no USDC spend cap is configured
    const result = await new RouteDockClient({ wallet: Keypair.random(), network: 'testnet' })
      .pay(BASE_URL + '/lookup')
    // #then the charge client accepts and signs the scoped asset
    assert.equal(result.mode, 'mpp-charge')
    assert.equal(result.txHash, 'scoped-xlm-settlement')
    assert.equal(result.amount, '0.0008')
    assert.equal(credentialCalls, 1)
    assert.equal(paidRequests, 1)
  })

  it('rejects the root USDC asset on /lookup before creating a credential', async (t) => {
    // #given an unsigned challenge tries to replace scoped XLM with root USDC
    challengeCurrency = USDC
    const manifest = makeManifest()
    let paidRequests = 0
    t.mock.method(Horizon.Server.prototype, 'loadAccount', async () => ({
      balances: [{ asset_type: 'native', balance: '50.0000000' }],
    }))
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      if (requestUrl(input).pathname === '/.well-known/routedock.json') return jsonResponse(manifest)
      paidRequests++
      throw new Error('A rejected challenge must not send a paid request')
    })
    // #when the caller pays the XLM endpoint
    const client = new RouteDockClient({ wallet: Keypair.random(), network: 'testnet' })
    // #then the asset binding refuses it before money can move
    await assert.rejects(() => client.pay(BASE_URL + '/lookup'), (error: unknown) => {
      assert.ok(error instanceof RouteDockPolicyRejectError)
      assert.equal(error.reason, 'challenge_asset_mismatch')
      return true
    })
    assert.equal(credentialCalls, 0)
    assert.equal(paidRequests, 0)
  })

  it('preflight reports only the asset-eligible modes and costs for /infer', async (t) => {
    // #given only x402 has an eligible asset on /infer
    const manifest = makeManifest()
    t.mock.method(globalThis, 'fetch', async () => jsonResponse(manifest))
    const horizon = t.mock.method(Horizon.Server.prototype, 'loadAccount', async () => {
      throw new Error('URL preflight must not check trustlines')
    })
    // #when the caller asks for a manifest-only preflight
    const result = await new RouteDockClient({ wallet: Keypair.random(), network: 'testnet' })
      .preflight(BASE_URL + '/infer')
    // #then ineligible charge mode cannot break or mislead the preflight
    assert.deepEqual(result.modes, ['x402'])
    assert.deepEqual(result.costs, [{ mode: 'x402', amount: '0.001', per: 'request', asset: 'USDC' }])
    assert.equal(horizon.mock.callCount(), 0)
  })

  it('refuses a forced mode with no asset for the request URL before preflight', async (t) => {
    const manifest = makeManifest()
    t.mock.method(globalThis, 'fetch', async () => jsonResponse(manifest))
    const horizon = t.mock.method(Horizon.Server.prototype, 'loadAccount', async () => {
      throw new Error('An ineligible mode must fail before preflight')
    })
    const client = new RouteDockClient({ wallet: Keypair.random(), network: 'testnet' })
    await assert.rejects(
      () => client.pay(BASE_URL + '/infer', { forceMode: 'mpp-charge' }),
      (error: unknown) => {
        assert.ok(error instanceof RouteDockNoSupportedModeError)
        assert.match(error.message, /mpp-charge.*eligible asset|eligible asset.*mpp-charge/)
        return true
      },
    )
    assert.equal(horizon.mock.callCount(), 0)
    assert.equal(credentialCalls, 0)
  })

  it('estimates the same endpoint-scoped mode and asset as pay()', async (t) => {
    const manifest = makeManifest()
    t.mock.method(globalThis, 'fetch', async () => jsonResponse(manifest))
    const client = new RouteDockClient({ wallet: Keypair.random(), network: 'testnet' })
    const inference = await client.estimateCost(BASE_URL + '/infer')
    const lookup = await client.estimateCost(BASE_URL + '/lookup')
    assert.deepEqual([inference.mode, inference.asset, inference.amount], ['x402', 'USDC', '0.001'])
    assert.deepEqual([lookup.mode, lookup.asset, lookup.amount], ['mpp-charge', 'XLM', '0.0008'])
  })

  it('filters ineligible modes before applying cost optimization', () => {
    const manifest = makeManifest()
    assert.equal(selectMode(manifest, { endpoint: BASE_URL + '/infer', optimize: 'cost' }), 'x402')
    assert.equal(selectMode(manifest, { endpoint: BASE_URL + '/lookup', optimize: 'cost' }), 'mpp-charge')
  })

  it('allows an asset-eligible deprecated fallback when an active mode is ineligible', () => {
    const manifest = { ...makeManifest(), deprecated_modes: ['x402' as const] }
    assert.equal(selectMode(manifest, { endpoint: BASE_URL + '/infer' }), 'x402')
  })

  it('cannot bypass endpoint eligibility with a caller-supplied endpoint option', async (t) => {
    const manifest = makeManifest()
    t.mock.method(globalThis, 'fetch', async () => jsonResponse(manifest))
    const client = new RouteDockClient({ wallet: Keypair.random(), network: 'testnet' })
    await assert.rejects(
      () => client.pay(BASE_URL + '/infer', { endpoint: BASE_URL + '/lookup', forceMode: 'mpp-charge' }),
      RouteDockNoSupportedModeError,
    )
  })
})
