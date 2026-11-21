/**
 * Fastify x402 adapter: a failed local verify answers 402 with fresh payment
 * requirements and the facilitator's reason, the same shape as a settlement
 * failure (#558). Fastify reuses `createX402Handler`, so this guards the
 * adapter wiring. The facilitator is mocked; runs in its own process.
 */

import { mock, describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { Keypair } from '@stellar/stellar-sdk'
import type { RouteDockManifest } from '../../types.js'

const payeeKeypair = Keypair.random()
const commitKeypair = Keypair.random()

const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const PAYER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

type SettleResponse = {
  success: boolean
  transaction: string
  payer?: string
  errorReason?: string
}

/** Scripted outcome of the next `settle` / `settlePayment` call. */
let settleResult: SettleResponse = {
  success: false,
  transaction: '',
  errorReason: 'settle_exact_stellar_transaction_submission_failed',
}
let settleCalls = 0
let verifyResult: { isValid: boolean; invalidReason?: string } = { isValid: true }
let verifyCalls = 0

mock.module('@x402/stellar/exact/facilitator', {
  namedExports: {
    ExactStellarScheme: class {
      async verify() {
        verifyCalls++
        return verifyResult
      }
      async settle() {
        settleCalls++
        return settleResult
      }
    },
  },
})

mock.module('@x402/core/server', {
  namedExports: {
    HTTPFacilitatorClient: class {},
    x402ResourceServer: class {
      register() {}
      async createPaymentRequiredResponse() {
        return { x402Version: 2, accepts: [] }
      }
      async settlePayment() {
        settleCalls++
        return settleResult
      }
    },
  },
})

mock.module('@x402/core/http', {
  namedExports: {
    decodePaymentSignatureHeader: () => ({
      x402Version: 2,
      accepted: {},
      payload: { transaction: 'signed-xdr' },
    }),
    encodePaymentRequiredHeader: (value: unknown) => `requirements:${JSON.stringify(value)}`,
    encodePaymentResponseHeader: (value: unknown) => `response:${JSON.stringify(value)}`,
  },
})

const { routedockFastify } = await import('../fastify.js')

const manifest: RouteDockManifest = {
  routedock: '1.0',
  name: 'Verify Failure Test',
  description: 'Unit test provider',
  modes: ['x402'],
  network: 'testnet',
  asset: 'USDC',
  asset_contract: ASSET_CONTRACT,
  payee: payeeKeypair.publicKey(),
  pricing: { x402: { amount: '0.001', per: 'request' } },
  endpoints: { price: { method: 'GET', path: '/price' } },
  tags: ['test'],
}

async function makeServer() {
  const downstream = { called: false }
  const app = Fastify()
  await app.register(
    routedockFastify({
      asset: 'USDC',
      assetContract: ASSET_CONTRACT,
      payee: payeeKeypair.publicKey(),
      network: 'testnet',
      payeeSecretKey: payeeKeypair.secret(),
      commitmentPublicKey: commitKeypair.publicKey(),
      manifest,
      modes: ['x402'],
      pricing: { x402: '0.001' },
    } as Parameters<typeof routedockFastify>[0]),
  )
  app.get('/price', async () => {
    downstream.called = true
    return { price: '42' }
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return { url: `http://127.0.0.1:${port}`, downstream, close: () => app.close() }
}

function paidRequest(url: string) {
  return fetch(`${url}/price`, { headers: { 'payment-signature': 'signed-payment' } })
}

beforeEach(() => {
  settleCalls = 0
  verifyCalls = 0
  verifyResult = { isValid: true }
  settleResult = { success: true, transaction: 'TX_HASH_1' }
})

describe('routedockFastify x402 — verify fails (#558)', () => {
  it('returns 402 with requirements and the invalid reason, never 401', async () => {
    verifyResult = { isValid: false, invalidReason: 'invalid_exact_stellar_payload_wrong_amount' }
    const h = await makeServer()
    try {
      const res = await paidRequest(h.url)

      assert.equal(verifyCalls, 1)
      assert.equal(settleCalls, 0, 'must not settle a payment that failed verification')
      assert.equal(res.status, 402)
      assert.ok(res.headers.get('x-payment-requirements'), 'carries fresh requirements')
      assert.equal(res.headers.get('x-payment-response'), null)
      const body = (await res.json()) as { error: string; reason?: string }
      assert.equal(body.error, 'Payment verification failed')
      assert.equal(body.reason, 'invalid_exact_stellar_payload_wrong_amount')
      assert.equal(h.downstream.called, false)
    } finally {
      await h.close()
    }
  })

  it('serves the resource when verification passes', async () => {
    const h = await makeServer()
    try {
      const res = await paidRequest(h.url)
      assert.equal(res.status, 200)
      assert.equal(verifyCalls, 1)
      assert.equal(h.downstream.called, true)
    } finally {
      await h.close()
    }
  })
})
