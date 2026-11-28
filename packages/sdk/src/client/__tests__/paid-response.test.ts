import assert from 'node:assert/strict'
import { beforeEach, mock, test, type TestContext } from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import { x402HTTPClient } from '@x402/core/client'
import { encodePaymentRequiredHeader, encodePaymentResponseHeader } from '@x402/core/http'
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types'
import { Receipt } from 'mppx'
import { X402Client } from '../x402Client.js'
import { RouteDockPaidResponseError, RouteDockPolicyRejectError } from '../../errors.js'
import { signManifest } from '../../manifest/sign.js'
import { InMemorySpendStore } from '../../store/SpendStore.js'
import type { RouteDockManifest } from '../../types.js'

const PAYEE = Keypair.random()
const RESOURCE_URL = 'https://paid-response.test/data'
const ASSET = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const TX_HASH = 'settled-transaction'
const REQUIREMENTS: PaymentRequirements = {
  scheme: 'exact',
  network: 'stellar:testnet',
  asset: ASSET,
  amount: '10000',
  payTo: PAYEE.publicKey(),
  maxTimeoutSeconds: 60,
  extra: { areFeesSponsored: true },
}

type Mode = 'x402' | 'mpp-charge'
type OnChallenge = (
  challenge: { request: Record<string, unknown> },
  helpers: { createCredential: () => Promise<string> },
) => Promise<string | undefined>

let reply: () => Response
let paidRequests = 0
let signingFailure: Error | undefined

mock.module('mppx/client', {
  namedExports: {
    Mppx: {
      create: (options: { onChallenge: OnChallenge }) => ({
        fetch: async () => {
          await options.onChallenge({
            request: {
              amount: REQUIREMENTS.amount,
              currency: ASSET,
              recipient: PAYEE.publicKey(),
              methodDetails: { network: 'stellar:testnet' },
            },
          }, {
            createCredential: async () => {
              if (signingFailure) throw signingFailure
              return 'Payment test-credential'
            },
          })
          paidRequests++
          return reply()
        },
        rawFetch: async () => {
          paidRequests++
          return reply()
        },
      }),
    },
  },
})
mock.module('@stellar/mpp/charge/client', {
  namedExports: { stellar: { charge: () => ({ name: 'stellar/charge', intent: 'charge' }) } },
})

const { MppChargeClient } = await import('../MppChargeClient.js')
const { RouteDockClient } = await import('../RouteDockClient.js')

beforeEach(() => {
  paidRequests = 0
  signingFailure = undefined
})

function settlementHeaders(mode: Mode, includeHash = true): Record<string, string> {
  if (!includeHash) return {}
  if (mode === 'x402') {
    return {
      'X-Payment-Response': encodePaymentResponseHeader({
        success: true, transaction: TX_HASH, network: 'stellar:testnet',
      }),
    }
  }
  return {
    'Payment-Receipt': Receipt.serialize(Receipt.from({
      method: 'stellar', reference: TX_HASH, status: 'success',
      timestamp: new Date().toISOString(),
    })),
  }
}

function configure(t: TestContext, mode: Mode, response: () => Response): RouteDockManifest {
  // #given a signed manifest and a payment layer that returns the supplied response.
  const manifest = signManifest({
    routedock: '1.0',
    name: 'Paid response provider',
    description: 'Paid response regression fixture',
    modes: [mode],
    network: 'testnet',
    asset: 'USDC',
    asset_contract: ASSET,
    payee: PAYEE.publicKey(),
    pricing: mode === 'x402'
      ? { x402: { amount: '0.001', per: 'request', facilitator: 'https://facilitator.test' } }
      : { 'mpp-charge': { amount: '0.001', per: 'request' } },
    endpoints: { data: { method: 'GET', path: '/data' } },
    tags: [],
  }, PAYEE.secret())
  reply = response
  t.mock.method(x402HTTPClient.prototype, 'createPaymentPayload', async (): Promise<PaymentPayload> => {
    if (signingFailure) throw signingFailure
    return { x402Version: 2, accepted: REQUIREMENTS, payload: {} }
  })
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).endsWith('/.well-known/routedock.json')) {
      return new Response(JSON.stringify(manifest), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      })
    }
    if (new Headers(init?.headers).has('PAYMENT-SIGNATURE')) {
      paidRequests++
      return reply()
    }
    return new Response(null, {
      status: 402,
      headers: {
        'X-Payment-Requirements': encodePaymentRequiredHeader({
          x402Version: 2, resource: { url: RESOURCE_URL }, accepts: [REQUIREMENTS],
        }),
      },
    })
  })
  return manifest
}

function spendingClient(): { client: InstanceType<typeof RouteDockClient>; store: InMemorySpendStore } {
  const payer = Keypair.random()
  const store = new InMemorySpendStore({ warn: false })
  // Avoid Horizon I/O without replacing the actual payment clients or cap logic.
  const cache = (RouteDockClient as unknown as {
    _trustlineCache: Map<string, { exists: boolean; expiresAt: number }>
  })._trustlineCache
  cache.set('testnet:' + payer.publicKey() + ':USDC', {
    exists: true, expiresAt: Date.now() + 300_000,
  })
  return {
    client: new RouteDockClient({
      wallet: payer, network: 'testnet', spendStore: store,
      spendCap: { daily: '0.001', asset: 'USDC' },
      retryPolicy: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
    }),
    store,
  }
}

for (const mode of ['x402', 'mpp-charge'] as const) {
  for (const [contentType, text] of [
    ['text/plain', 'paid data'],
    ['text/csv', 'name,value\nanswer,42'],
    ['text/html', '<html>paid data</html>'],
    ['application/json', '{invalid JSON'],
  ] as const) {
    test(mode + ' preserves the settlement when a paid response is ' + contentType, async (t) => {
      const manifest = configure(t, mode, () => new Response(text, {
        headers: { 'Content-Type': contentType, ...settlementHeaders(mode) },
      }))
      const client = mode === 'x402'
        ? new X402Client(Keypair.random().secret(), 'testnet')
        : new MppChargeClient(Keypair.random(), 'testnet')

      // #when the paid response cannot be parsed as JSON.
      const result = await client.pay(RESOURCE_URL, manifest)

      // #then the successful payment and its original body remain visible.
      assert.equal(result.data, text)
      assert.equal(result.contentType, contentType)
      assert.equal(result.txHash, TX_HASH)
      assert.equal(result.amount, '0.001')
      assert.equal(paidRequests, 1)
    })
  }

  test(mode + ' still parses valid JSON after payment', async (t) => {
    const manifest = configure(t, mode, () => new Response('{"answer":42}', {
      headers: { 'Content-Type': 'application/json', ...settlementHeaders(mode) },
    }))
    const client = mode === 'x402'
      ? new X402Client(Keypair.random().secret(), 'testnet')
      : new MppChargeClient(Keypair.random(), 'testnet')
    const result = await client.pay(RESOURCE_URL, manifest)
    assert.deepEqual(result.data, { answer: 42 })
    assert.equal(result.txHash, TX_HASH)
  })

  test(mode + ' preserves payment on a 204 response with no body or content type', async (t) => {
    const manifest = configure(t, mode, () => new Response(null, {
      status: 204, headers: settlementHeaders(mode),
    }))
    const client = mode === 'x402'
      ? new X402Client(Keypair.random().secret(), 'testnet')
      : new MppChargeClient(Keypair.random(), 'testnet')

    const result = await client.pay(RESOURCE_URL, manifest)
    assert.equal(result.data, '')
    assert.equal(result.contentType, undefined)
    assert.equal(result.txHash, TX_HASH)
    assert.equal(result.amount, '0.001')
    assert.equal(paidRequests, 1)
  })

  test(mode + ' counts a paid text response and blocks a second payment at the daily cap', async (t) => {
    configure(t, mode, () => new Response('paid data', {
      headers: { 'Content-Type': 'text/plain', ...settlementHeaders(mode) },
    }))
    const { client, store } = spendingClient()

    // #when the payment succeeds with text instead of JSON.
    const result = await client.pay(RESOURCE_URL)
    assert.equal(result.data, 'paid data')
    assert.equal((await store.read())?.totalMicros, '10000')

    // #then retrying the URL cannot restore or bypass the daily cap.
    await assert.rejects(client.pay(RESOURCE_URL), (error: unknown) =>
      error instanceof RouteDockPolicyRejectError && error.reason === 'local_daily_cap_exceeded',
    )
    assert.equal(paidRequests, 1)
  })

  for (const includeHash of [true, false]) {
    test(mode + ' retains paid spend when the body stream fails, hash=' + includeHash, async (t) => {
      const cause = new Error('body stream interrupted')
      configure(t, mode, () => new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.error(cause) },
      }), {
        headers: { 'Content-Type': 'text/plain', ...settlementHeaders(mode, includeHash) },
      }))
      const { client, store } = spendingClient()

      // #when the provider already accepted payment but its body cannot be read.
      await assert.rejects(client.pay(RESOURCE_URL), (error: unknown) => {
        assert.ok(error instanceof RouteDockPaidResponseError)
        assert.equal(error.txHash, includeHash ? TX_HASH : null)
        assert.equal(error.amount, '0.001')
        assert.equal(error.mode, mode)
        assert.equal(error.contentType, 'text/plain')
        assert.equal(error.retryable, false)
        assert.equal(error.cause, cause)
        return true
      })

      // #then neither SDK retry nor an agent retry can release that spend.
      assert.equal((await store.read())?.totalMicros, '10000')
      await assert.rejects(client.pay(RESOURCE_URL), (error: unknown) =>
        error instanceof RouteDockPolicyRejectError && error.reason === 'local_daily_cap_exceeded',
      )
      assert.equal(paidRequests, 1)
    })
  }

  test(mode + ' still releases the reservation when signing fails before payment', async (t) => {
    configure(t, mode, () => new Response('paid data', {
      headers: { 'Content-Type': 'text/plain', ...settlementHeaders(mode) },
    }))
    const { client, store } = spendingClient()
    signingFailure = new Error('cannot sign')
    await assert.rejects(client.pay(RESOURCE_URL))
    assert.equal((await store.read())?.totalMicros, '0')
    assert.equal(paidRequests, 0)

    signingFailure = undefined
    await client.pay(RESOURCE_URL)
    assert.equal((await store.read())?.totalMicros, '10000')
  })
}
