/**
 * Express/Fastify-side x402 handler: a settle result of `{ success: false }`
 * must not be treated as a settled payment (#392).
 *
 * `createX402Handler` shares the fail-closed rule with the Hono adapter, so the
 * same scenarios are driven here through a real Express app. The facilitator is
 * mocked (as in hono-settle-failure.test.ts) because it reports failures as
 * data instead of throwing. Runs in its own process, so the other provider
 * tests are unaffected.
 */

import { mock, describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import express from 'express'
import type { Request, Response } from 'express'
import { Keypair } from '@stellar/stellar-sdk'
import type { RouteDockManifest } from '../../types.js'
import type { RouteDockMiddlewareOptions } from '../routedockMiddleware.js'

const payeeKeypair = Keypair.random()
const commitKeypair = Keypair.random()

const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const PAYER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

type SettleResponse = {
  success: boolean
  transaction: string
  errorReason?: string
}

/** Scripted outcome of the next `settle` / `settlePayment` call. */
let settleResult: SettleResponse = {
  success: false,
  transaction: '',
  errorReason: 'settle_exact_stellar_transaction_submission_failed',
}
let settleCalls = 0

mock.module('@x402/stellar/exact/facilitator', {
  namedExports: {
    ExactStellarScheme: class {
      async verify() {
        return { isValid: true }
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
      authorization: { credentials: [{ publicKey: PAYER }] },
    }),
    encodePaymentRequiredHeader: (value: unknown) => `requirements:${JSON.stringify(value)}`,
    encodePaymentResponseHeader: (value: unknown) => `response:${JSON.stringify(value)}`,
  },
})

const { routedock } = await import('../routedockMiddleware.js')

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
  modes: ['x402'] as ('x402' | 'mpp-charge' | 'mpp-session')[],
  pricing: { x402: '0.001' },
}

interface Harness {
  url: string
  seenSet: string[]
  settled: string[][]
  downstream: { called: boolean }
  close: () => Promise<void>
}

async function makeHarness(
  overrides: Partial<RouteDockMiddlewareOptions> = {},
): Promise<Harness> {
  const seenSet: string[] = []
  const settled: string[][] = []
  const downstream = { called: false }

  const app = express()
  app.use(
    routedock({
      ...BASE_OPTS,
      seenTxStore: {
        get: () => undefined,
        set: (key: string) => {
          seenSet.push(key)
        },
      },
      onSettled: async (txHash: string, amount: string, mode: string, payer: string | null) => {
        settled.push([txHash, amount, mode, String(payer)])
      },
      ...overrides,
    } as RouteDockMiddlewareOptions),
  )
  app.get('/price', (_req: Request, res: Response) => {
    downstream.called = true
    res.json({ price: '42' })
  })

  const { url, close } = await new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    const server = createServer(app)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((res) => server.close(() => res())),
      })
    })
  })

  return { url, seenSet, settled, downstream, close }
}

function paidRequest(url: string) {
  return fetch(`${url}/price`, { headers: { 'payment-signature': 'signed-payment' } })
}

beforeEach(() => {
  settleCalls = 0
  settleResult = {
    success: false,
    transaction: '',
    errorReason: 'settle_exact_stellar_transaction_submission_failed',
  }
})

describe('routedock Express x402 — settle returns success: false (local facilitator)', () => {
  it('returns 402 with requirements and does not serve the resource', async () => {
    const h = await makeHarness()
    try {
      const res = await paidRequest(h.url)

      assert.equal(settleCalls, 1)
      assert.equal(res.status, 402)
      assert.equal(res.headers.get('x-payment-response'), null)
      assert.ok(res.headers.get('x-payment-requirements'))
      const body = (await res.json()) as { error: string; reason?: string }
      assert.equal(body.error, 'Payment settlement failed')
      assert.equal(body.reason, 'settle_exact_stellar_transaction_submission_failed')

      await new Promise((r) => setImmediate(r))
      assert.equal(h.downstream.called, false, 'downstream handler must not run')
      assert.deepEqual(h.seenSet, [], 'no idempotency record for a failed settle')
      assert.deepEqual(h.settled, [], 'onSettled must not fire for a failed settle')
    } finally {
      await h.close()
    }
  })

  it('rejects success: true with an empty transaction hash', async () => {
    settleResult = { success: true, transaction: '' }
    const h = await makeHarness()
    try {
      const res = await paidRequest(h.url)

      assert.equal(res.status, 402)
      assert.equal(res.headers.get('x-payment-response'), null)
      await new Promise((r) => setImmediate(r))
      assert.equal(h.downstream.called, false)
      assert.deepEqual(h.seenSet, [])
      assert.deepEqual(h.settled, [])
    } finally {
      await h.close()
    }
  })

  it('serves the resource and records the settlement on success', async () => {
    settleResult = { success: true, transaction: 'TX_HASH_1' }
    const h = await makeHarness()
    try {
      const res = await paidRequest(h.url)

      assert.equal(res.status, 200)
      assert.ok(res.headers.get('x-payment-response'))
      assert.equal(h.downstream.called, true)
      assert.equal(h.seenSet.length, 1)

      await new Promise((r) => setImmediate(r))
      assert.equal(h.settled.length, 1)
      assert.equal(h.settled[0]?.[0], 'TX_HASH_1')
    } finally {
      await h.close()
    }
  })
})

describe('routedock Express x402 — settle returns success: false (OZ facilitator)', () => {
  it('returns 402 and does not serve the resource', async () => {
    const h = await makeHarness({ network: 'mainnet', facilitatorApiKey: 'test-key' })
    try {
      const res = await paidRequest(h.url)

      assert.equal(settleCalls, 1)
      assert.equal(res.status, 402)
      assert.equal(res.headers.get('x-payment-response'), null)
      assert.ok(res.headers.get('x-payment-requirements'))

      await new Promise((r) => setImmediate(r))
      assert.equal(h.downstream.called, false)
      assert.deepEqual(h.seenSet, [])
      assert.deepEqual(h.settled, [])
    } finally {
      await h.close()
    }
  })
})
