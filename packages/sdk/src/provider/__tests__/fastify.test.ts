import assert from 'node:assert/strict'
import { describe, it, after } from 'node:test'
import { createServer, type Server } from 'node:http'
import Fastify from 'fastify'
import { Keypair } from '@stellar/stellar-sdk'
import { routedockFastify, type RouteDockFastifyOptions } from '../fastify.js'
import type { RouteDockManifest } from '../../types.js'
import {
  InMemorySeenTxStore,
  paymentIdempotencyKey,
  type SeenTxStore,
} from '../SeenTxStore.js'
import { usdcToStroops } from '../../internal/usdc.js'

// Generate fresh keypairs — avoids hardcoding secrets while keeping tests self-contained
const payeeKeypair = Keypair.random()
const commitKeypair = Keypair.random()

const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const CHANNEL_CONTRACT = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'

const manifest: RouteDockManifest = {
  routedock: '1.0',
  name: 'Fastify Test Service',
  description: 'Unit test provider for Fastify adapter',
  modes: ['x402', 'mpp-charge', 'mpp-session'],
  network: 'testnet',
  asset: 'USDC',
  asset_contract: ASSET_CONTRACT,
  payee: payeeKeypair.publicKey(),
  pricing: {
    x402: { amount: '0.001', per: 'request' },
    'mpp-charge': { amount: '0.0008', per: 'request' },
    'mpp-session': {
      rate: '0.0001',
      per: 'voucher',
      channel_factory: CHANNEL_CONTRACT,
      min_deposit: '0.10',
      refund_waiting_period_ledgers: 17280,
    },
  },
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

/** Spin up a Fastify instance, return its base URL and a close function. */
async function makeServer(
  overrides: Partial<RouteDockFastifyOptions> = {},
): Promise<{ url: string; close: () => Promise<void> }> {
  const fastify = Fastify()
  await fastify.register(
    routedockFastify({
      ...BASE_OPTS,
      modes: ['x402', 'mpp-charge', 'mpp-session'],
      pricing: {
        x402: '0.001',
        'mpp-charge': '0.0008',
        'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT },
      },
      ...overrides,
    } as Parameters<typeof routedockFastify>[0]),
  )

  fastify.get('/price', async () => ({ price: '42' }))

  await fastify.listen({ port: 0, host: '127.0.0.1' })
  const address = fastify.server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => fastify.close(),
  }
}

describe('routedockFastify — manifest endpoint', () => {
  it('serves a signed /.well-known/routedock.json', async () => {
    const { url, close } = await makeServer({ modes: [] as ('x402' | 'mpp-charge' | 'mpp-session')[], pricing: {} })
    try {
      const res = await fetch(`${url}/.well-known/routedock.json`)
      assert.equal(res.status, 200)
      const body = await res.json() as { name: string; signature: string }
      assert.equal(body.name, manifest.name, 'manifest name should match')
      assert.ok(body.signature, 'manifest should be signed (signature field present)')
    } finally {
      await close()
    }
  })

  it('passes through to route handler when no modes are configured', async () => {
    const { url, close } = await makeServer({ modes: [], pricing: {} })
    try {
      const res = await fetch(`${url}/price`)
      assert.equal(res.status, 200)
      const body = await res.json() as { price: string }
      assert.equal(body.price, '42')
    } finally {
      await close()
    }
  })
})

describe('routedockFastify — x402 flow', () => {
  it('returns 402 with X-Payment-Requirements when no payment header', async () => {
    const { url, close } = await makeServer({ modes: ['x402'], pricing: { x402: '0.001' } })
    try {
      const res = await fetch(`${url}/price`)
      assert.equal(res.status, 402)
      assert.ok(
        res.headers.get('x-payment-requirements'),
        'expected X-Payment-Requirements header on 402',
      )
      const body = await res.json() as { error: string }
      assert.equal(body.error, 'Payment Required')
    } finally {
      await close()
    }
  })

  it('routes to x402 handler when x-preferred-mode: x402 header is set', async () => {
    const { url, close } = await makeServer({
      modes: ['x402', 'mpp-charge'],
      pricing: { x402: '0.001', 'mpp-charge': '0.0008' },
    })
    try {
      const res = await fetch(`${url}/price`, {
        headers: { 'x-preferred-mode': 'x402' },
      })
      // Without a valid x402 payment header, still 402
      assert.equal(res.status, 402)
      assert.ok(res.headers.get('x-payment-requirements'), 'x402 handler should set X-Payment-Requirements')
    } finally {
      await close()
    }
  })

  it('passes through to route handler on settled payment (idempotency cache hit)', async () => {
    const stubStore: SeenTxStore = {
      get: () => ({ txHash: 'abc', headers: { 'X-Payment-Response': 'cached' } }),
      set: () => {},
    }
    const { url, close } = await makeServer({
      modes: ['x402'],
      pricing: { x402: '0.001' },
      seenTxStore: stubStore,
    })
    try {
      const res = await fetch(`${url}/price`, {
        headers: { 'x-payment': 'settled-payment' },
        signal: AbortSignal.timeout(3000),
      })
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('x-payment-response'), 'cached')
      const body = (await res.json()) as { price: string }
      assert.equal(body.price, '42')
    } finally {
      await close()
    }
  })
})

describe('routedockFastify — mpp-charge flow', () => {
  it('returns 402 challenge when no authorization header', async () => {
    const { url, close } = await makeServer({ modes: ['mpp-charge'], pricing: { 'mpp-charge': '0.0008' } })
    try {
      const res = await fetch(`${url}/price`)
      assert.equal(res.status, 402)
    } finally {
      await close()
    }
  })

  it('passes through to route handler on settled payment (idempotency cache hit)', async () => {
    const stubStore: SeenTxStore = {
      get: () => ({ txHash: 'abc', headers: { 'payment-receipt': 'cached' } }),
      set: () => {},
    }
    const { url, close } = await makeServer({
      modes: ['mpp-charge'],
      pricing: { 'mpp-charge': '0.0008' },
      seenTxStore: stubStore,
    })
    try {
      const res = await fetch(`${url}/price`, {
        headers: { authorization: 'Payment test' },
        signal: AbortSignal.timeout(3000),
      })
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('payment-receipt'), 'cached')
      const body = (await res.json()) as { price: string }
      assert.equal(body.price, '42')
    } finally {
      await close()
    }
  })
})

describe('routedockFastify — mpp-session flow', () => {
  it('returns 402 challenge when no authorization header', async () => {
    const { url, close } = await makeServer({ modes: ['mpp-session'], pricing: { 'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT } } })
    try {
      const res = await fetch(`${url}/price`)
      assert.equal(res.status, 402)
    } finally {
      await close()
    }
  })

  it('returns { closeTxHash: null } on DELETE with no prior vouchers', async () => {
    const { url, close } = await makeServer({ modes: ['mpp-session'], pricing: { 'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT } } })
    try {
      const res = await fetch(`${url}/price`, { method: 'DELETE' })
      assert.equal(res.status, 200)
      const body = await res.json() as { closeTxHash: null }
      assert.equal(body.closeTxHash, null)
    } finally {
      await close()
    }
  })
})

describe('routedockFastify — settlement idempotency', () => {
  const X402_AMOUNT = String(usdcToStroops('0.001'))

  /** Seed one settled-header record for `path` at `amount` stroops. */
  async function seedSettlement(
    seenStore: InMemorySeenTxStore,
    path: string,
    amount: string,
    record: {
      txHash: string
      createdAt: number
      headers?: Record<string, string>
    },
  ): Promise<void> {
    const key = await paymentIdempotencyKey(
      (n) => (n === 'payment-signature' ? 'SIG' : undefined),
      { method: 'GET', path, amount, payTo: payeeKeypair.publicKey() },
    )
    assert.ok(key)
    await seenStore.set(key, record)
  }

  /** Build an app whose `/price` handler counts how many times it ran. */
  async function makeCountingServer(
    overrides: Partial<RouteDockFastifyOptions> = {},
  ): Promise<{ url: string; runs: () => number; close: () => Promise<void> }> {
    const app = Fastify()
    await app.register(
      routedockFastify({
        ...BASE_OPTS,
        modes: ['x402'],
        pricing: { x402: '0.001' },
        ...overrides,
      } as RouteDockFastifyOptions),
    )
    let handlerRuns = 0
    app.get('/price', async () => {
      handlerRuns++
      return { price: '42' }
    })
    await app.listen({ port: 0, host: '127.0.0.1' })
    const address = app.server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    return {
      url: `http://127.0.0.1:${port}`,
      runs: () => handlerRuns,
      close: () => app.close(),
    }
  }

  it('replays cached settlement on duplicate payment-signature header', async () => {
    const seenStore = new InMemorySeenTxStore()
    const settled: string[] = []
    await seedSettlement(seenStore, '/price', X402_AMOUNT, {
      txHash: 'CACHED_TX_HASH',
      headers: { 'X-Payment-Response': 'cached-response' },
      createdAt: Date.now(),
    })

    const { url, close } = await makeServer({
      modes: ['x402'],
      pricing: { x402: '0.001' },
      seenTxStore: seenStore,
      onSettled: async (txHash: string) => {
        settled.push(txHash)
      },
    })
    try {
      const res = await fetch(`${url}/price`, {
        headers: { 'payment-signature': 'SIG' },
      })
      assert.equal(res.status, 200)
      const data = (await res.json()) as { price: string }
      assert.equal(data.price, '42')
      assert.equal(res.headers.get('x-payment-response'), 'cached-response')

      await new Promise((r) => setImmediate(r))
      assert.equal(settled.length, 0)
    } finally {
      await close()
    }
  })

  it('rejects the second replay with 402 and does not run the route handler again', async () => {
    const seenStore = new InMemorySeenTxStore({ warn: false })
    await seedSettlement(seenStore, '/price', X402_AMOUNT, {
      txHash: 'TX',
      createdAt: Date.now(),
    })

    const { url, runs, close } = await makeCountingServer({ seenTxStore: seenStore })
    try {
      const first = await fetch(`${url}/price`, { headers: { 'payment-signature': 'SIG' } })
      assert.equal(first.status, 200)
      const second = await fetch(`${url}/price`, { headers: { 'payment-signature': 'SIG' } })
      assert.equal(second.status, 402)
      const body = (await second.json()) as { error: string }
      assert.equal(body.error, 'Payment already used')
      assert.equal(runs(), 1)
    } finally {
      await close()
    }
  })

  it('rejects a settlement older than the replay window', async () => {
    const seenStore = new InMemorySeenTxStore({ warn: false })
    await seedSettlement(seenStore, '/price', X402_AMOUNT, {
      txHash: 'TX',
      headers: { 'X-Payment-Response': 'cached-response' },
      createdAt: Date.now() - 61_000,
    })

    const { url, close } = await makeServer({
      modes: ['x402'],
      pricing: { x402: '0.001' },
      seenTxStore: seenStore,
    })
    try {
      const res = await fetch(`${url}/price`, { headers: { 'payment-signature': 'SIG' } })
      assert.equal(res.status, 402)
    } finally {
      await close()
    }
  })

  it('does not replay a payment settled on a different route against a shared store', async () => {
    const seenStore = new InMemorySeenTxStore({ warn: false })
    await seedSettlement(seenStore, '/cheap', X402_AMOUNT, {
      txHash: 'TX',
      createdAt: Date.now(),
    })

    // Two priced mount points sharing one store: the scope must key the
    // settled header to the route that settled it.
    const runs = { cheap: 0, expensive: 0 }
    const app = Fastify()
    await app.register(async (scope) => {
      await scope.register(
        routedockFastify({
          ...BASE_OPTS,
          modes: ['x402'],
          pricing: { x402: '0.001' },
          seenTxStore: seenStore,
        }),
      )
      scope.get('/', async () => {
        runs.cheap++
        return { price: 'cheap' }
      })
    }, { prefix: '/cheap' })
    await app.register(async (scope) => {
      await scope.register(
        routedockFastify({
          ...BASE_OPTS,
          modes: ['x402'],
          pricing: { x402: '5.00' },
          seenTxStore: seenStore,
        }),
      )
      scope.get('/', async () => {
        runs.expensive++
        return { price: 'expensive' }
      })
    }, { prefix: '/expensive' })

    await app.listen({ port: 0, host: '127.0.0.1' })
    const address = app.server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const url = `http://127.0.0.1:${port}`
    try {
      // Request /expensive before /cheap: the reverse order hides a header-only
      // key behind the replay cap instead of the route scope.
      const expensiveRes = await fetch(`${url}/expensive`, { headers: { 'payment-signature': 'SIG' } })
      assert.notEqual(expensiveRes.status, 200)
      assert.equal(runs.expensive, 0)

      const cheapRes = await fetch(`${url}/cheap`, { headers: { 'payment-signature': 'SIG' } })
      assert.equal(cheapRes.status, 200)
      assert.equal(runs.cheap, 1)
    } finally {
      await app.close()
    }
  })
})

describe('routedockFastify — constructor validation', () => {
  it('throws when mpp-session mode is enabled without commitmentPublicKey', () => {
    assert.throws(
      () =>
        routedockFastify({
          ...BASE_OPTS,
          commitmentPublicKey: undefined,
          modes: ['mpp-session'],
          pricing: { 'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT } },
        } as unknown as Parameters<typeof routedockFastify>[0]),
      /requirescommitmentPublicKey|commitmentPublicKey/i,
    )
  })
})
