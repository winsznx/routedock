/**
 * Hono x402: a settle result of `{ success: false }` must not be treated as a
 * settled payment (#392).
 *
 * The x402 facilitator reports failures as data instead of throwing, so the
 * handler has to inspect the result. This file mocks the facilitator (and the
 * HTTP-layer codecs) so the failure branch can be driven without a live chain.
 * It runs in its own process, so the real hono.test.ts is unaffected.
 */

import { mock, describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { Keypair } from '@stellar/stellar-sdk'
import type { RouteDockManifest } from '../../types.js'
import type { RouteDockHonoOptions } from '../hono.js'

const payeeKeypair = Keypair.random()
const commitKeypair = Keypair.random()

const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const PAYER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

type SettleResponse = {
  success: boolean
  transaction: string
  payer?: string | undefined
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

const { routedockHono } = await import('../hono.js')

const manifest: RouteDockManifest = {
  routedock: '1.0',
  name: 'Settle Failure Test',
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

const BASE_OPTS = {
  asset: 'USDC',
  assetContract: ASSET_CONTRACT,
  payee: payeeKeypair.publicKey(),
  network: 'testnet' as const,
  payeeSecretKey: payeeKeypair.secret(),
  commitmentPublicKey: commitKeypair.publicKey(),
  manifest,
}

interface Harness {
  app: Hono
  seenSet: string[]
  settled: string[][]
  downstream: { called: boolean }
}

function makeHarness(overrides: Partial<RouteDockHonoOptions> = {}): Harness {
  const seenSet: string[] = []
  const settled: string[][] = []
  const downstream = { called: false }

  const app = new Hono()
  app.use(
    '*',
    routedockHono({
      ...BASE_OPTS,
      modes: ['x402'],
      pricing: { x402: '0.001' },
      seenTxStore: {
        get: () => undefined,
        set: (key: string) => {
          seenSet.push(key)
        },
      },
      onSettled: async (txHash: string, amount: string, mode: string, payer: string | null) => {
        settled.push([txHash, amount, mode, String(payer)])
      },
      manifest: { ...manifest, network: overrides.network ?? 'testnet' },
      ...overrides,
    }),
  )
  app.get('/price', (c) => {
    downstream.called = true
    return c.json({ price: '42' })
  })

  return { app, seenSet, settled, downstream }
}

function paidRequest(app: Hono) {
  return app.request('/price', { headers: { 'payment-signature': 'signed-payment' } })
}

beforeEach(() => {
  settleCalls = 0
  verifyCalls = 0
  verifyResult = { isValid: true }
  settleResult = {
    success: false,
    transaction: '',
    errorReason: 'settle_exact_stellar_transaction_submission_failed',
  }
})

describe('routedockHono x402 — settle returns success: false (local facilitator)', () => {
  it('returns 402 and does not serve the resource', async () => {
    const h = makeHarness()

    const res = await paidRequest(h.app)

    assert.equal(settleCalls, 1)
    assert.equal(res.status, 402)
    assert.equal(res.headers.get('x-payment-response'), null)
    assert.ok(res.headers.get('x-payment-requirements'))
    const body = (await res.json()) as { error: string; reason?: string }
    assert.equal(body.error, 'Payment settlement failed')
    assert.equal(body.reason, 'settle_exact_stellar_transaction_submission_failed')

    assert.equal(h.downstream.called, false, 'downstream handler must not run')
    assert.deepEqual(h.seenSet, [], 'no idempotency record for a failed settle')
    assert.deepEqual(h.settled, [], 'onSettled must not fire for a failed settle')
  })

  it('rejects success: true with an empty transaction hash', async () => {
    settleResult = { success: true, transaction: '' }
    const h = makeHarness()

    const res = await paidRequest(h.app)

    assert.equal(res.status, 402)
    assert.equal(h.downstream.called, false)
    assert.deepEqual(h.settled, [])
  })

  it('serves the resource and records the settlement on success', async () => {
    settleResult = { success: true, transaction: 'TX_HASH_1' }
    const h = makeHarness()

    const res = await paidRequest(h.app)

    assert.equal(res.status, 200)
    assert.ok(res.headers.get('x-payment-response'))
    assert.equal(h.downstream.called, true)
    assert.equal(h.seenSet.length, 1)

    await new Promise((r) => setImmediate(r))
    assert.equal(h.settled.length, 1)
    assert.equal(h.settled[0]?.[0], 'TX_HASH_1')
  })
})

describe('routedockHono x402 — verify fails (local facilitator, #558)', () => {
  it('returns 402 with requirements and the invalid reason, never 401', async () => {
    verifyResult = { isValid: false, invalidReason: 'invalid_exact_stellar_payload_wrong_amount' }
    const h = makeHarness()

    const res = await paidRequest(h.app)

    assert.equal(verifyCalls, 1)
    assert.equal(settleCalls, 0, 'must not settle a payment that failed verification')
    assert.equal(res.status, 402)
    assert.ok(res.headers.get('x-payment-requirements'), 'carries fresh requirements')
    assert.equal(res.headers.get('x-payment-response'), null)
    const body = (await res.json()) as { error: string; reason?: string }
    assert.equal(body.error, 'Payment verification failed')
    assert.equal(body.reason, 'invalid_exact_stellar_payload_wrong_amount')

    assert.equal(h.downstream.called, false)
    assert.deepEqual(h.seenSet, [])
    assert.deepEqual(h.settled, [])
  })

  it('omits reason when the facilitator gives none', async () => {
    verifyResult = { isValid: false }
    const h = makeHarness()

    const res = await paidRequest(h.app)

    assert.equal(res.status, 402)
    assert.ok(res.headers.get('x-payment-requirements'))
    const body = (await res.json()) as { error: string; reason?: string }
    assert.equal(body.error, 'Payment verification failed')
    assert.equal('reason' in body, false)
  })
})

describe('routedockHono x402 — settle returns success: false (OZ facilitator)', () => {
  it('returns 402 and does not serve the resource', async () => {
    const h = makeHarness({ network: 'mainnet', facilitatorApiKey: 'test-key' })

    const res = await paidRequest(h.app)

    assert.equal(res.status, 402)
    assert.equal(res.headers.get('x-payment-response'), null)
    assert.equal(h.downstream.called, false)
    assert.deepEqual(h.seenSet, [])
    assert.deepEqual(h.settled, [])
  })
})

describe('routedockHono x402 - payer attribution (#730)', () => {
  it('passes the facilitator payer to onSettled', async () => {
    settleResult = { success: true, transaction: 'TX_HASH_1', payer: PAYER }
    const h = makeHarness()
    const res = await paidRequest(h.app)
    assert.equal(res.status, 200)
    await new Promise((r) => setImmediate(r))
    assert.equal(h.settled[0]?.[3], PAYER)
  })

  it('reports null when the facilitator omits or mangles the payer', async () => {
    for (const payer of [undefined, 'not-a-key']) {
      settleResult = { success: true, transaction: 'TX_HASH_1', payer }
      const h = makeHarness()
      const res = await paidRequest(h.app)
      assert.equal(res.status, 200)
      await new Promise((r) => setImmediate(r))
      assert.equal(h.settled[0]?.[3], 'null')
    }
  })
})
