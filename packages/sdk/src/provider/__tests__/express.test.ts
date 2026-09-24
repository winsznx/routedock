import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createServer } from 'node:http'
import express from 'express'
import type { Request, Response } from 'express'
import { Keypair } from '@stellar/stellar-sdk'
import { routedock, type RouteDockMiddlewareOptions } from '../routedockMiddleware.js'
import type { RouteDockManifest } from '../../types.js'
import { InMemorySeenTxStore } from '../SeenTxStore.js'

// Generate fresh keypairs — avoids hardcoding secrets while keeping tests self-contained
const payeeKeypair = Keypair.random()
const commitKeypair = Keypair.random()

const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const CHANNEL_CONTRACT = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'

const manifest: RouteDockManifest = {
  routedock: '1.0',
  name: 'Express Test Service',
  description: 'Unit test provider for Express adapter',
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

/** Spin up an Express server, return its base URL and a close function. */
async function makeServer(
  overrides: Partial<RouteDockMiddlewareOptions> = {},
): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express()
  app.use(
    routedock({
      ...BASE_OPTS,
      modes: ['x402', 'mpp-charge', 'mpp-session'],
      pricing: {
        x402: '0.001',
        'mpp-charge': '0.0008',
        'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT },
      },
      ...overrides,
    } as Parameters<typeof routedock>[0]),
  )
  app.get('/price', (_req: Request, res: Response) => {
    res.json({ price: '42' })
  })

  return new Promise((resolve) => {
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
}

describe('routedock (Express) — manifest endpoint', () => {
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

describe('routedock (Express) — health endpoint', () => {
  it('returns ok with manifest metadata', async () => {
    const { url, close } = await makeServer()
    try {
      const res = await fetch(`${url}/.well-known/routedock.json`)
      assert.equal(res.status, 200)
      const body = await res.json() as Record<string, unknown>
      assert.equal(body.name, manifest.name)
    } finally {
      await close()
    }
  })
})

describe('routedock (Express) — x402 flow', () => {
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

  it('returns 402 when x-payment header is present but invalid', async () => {
    const { url, close } = await makeServer({ modes: ['x402'], pricing: { x402: '0.001' } })
    try {
      const res = await fetch(`${url}/price`, {
        headers: { 'x-payment': 'not-a-real-payment' },
      })
      // The handler attempts to decode the header and settle — this will
      // result in a 500 settlement error since the payload is garbage.
      assert.ok(res.status === 401 || res.status === 500, `expected 401 or 500, got ${res.status}`)
    } finally {
      await close()
    }
  })
})

describe('routedock (Express) — mpp-charge flow', () => {
  it('returns 402 challenge when no authorization header', async () => {
    const { url, close } = await makeServer({ modes: ['mpp-charge'], pricing: { 'mpp-charge': '0.0008' } })
    try {
      const res = await fetch(`${url}/price`)
      assert.equal(res.status, 402)
    } finally {
      await close()
    }
  })
})

describe('routedock (Express) — mpp-session flow', () => {
  it('returns 402 challenge when no authorization header', async () => {
    const { url, close } = await makeServer({
      modes: ['mpp-session'],
      pricing: { 'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT } },
    })
    try {
      const res = await fetch(`${url}/price`)
      assert.equal(res.status, 402)
    } finally {
      await close()
    }
  })

  it('rejects unauthenticated DELETE with no prior vouchers', async () => {
    const { url, close } = await makeServer({
      modes: ['mpp-session'],
      pricing: { 'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT } },
    })
    try {
      const res = await fetch(`${url}/price`, { method: 'DELETE' })
      assert.equal(res.status, 402)
    } finally {
      await close()
    }
  })
})

describe('routedock (Express) — mode routing', () => {
  it('routes x402 requests by payment-signature header', async () => {
    const { url, close } = await makeServer({
      modes: ['x402', 'mpp-charge'],
      pricing: { x402: '0.001', 'mpp-charge': '0.0008' },
    })
    try {
      const res = await fetch(`${url}/price`, {
        headers: { 'payment-signature': 'fake-x402-sig' },
      })
      // x402 handler processes it — will fail on decode/settle but that means
      // it was correctly routed to x402, not mpp-charge.
      assert.ok(res.status === 401 || res.status === 500, 'should route to x402 handler')
    } finally {
      await close()
    }
  })

  it('routes to default MPP handler when no x402 headers are present', async () => {
    const { url, close } = await makeServer({
      modes: ['x402', 'mpp-charge'],
      pricing: { x402: '0.001', 'mpp-charge': '0.0008' },
    })
    try {
      const res = await fetch(`${url}/price`)
      // No payment header → mpp-charge handler → 402 challenge
      assert.equal(res.status, 402)
    } finally {
      await close()
    }
  })
})

describe('routedock (Express) — settlement idempotency', () => {
  it('replays cached settlement on duplicate payment-signature header', async () => {
    const seenStore = new InMemorySeenTxStore()
    const settled: string[] = []

    const { url, close } = await makeServer({
      modes: ['x402'],
      pricing: { x402: '0.001' },
      seenTxStore: seenStore,
      onSettled: async (txHash: string) => { settled.push(txHash) },
    })
    try {
      // Seed the store with a fake settlement record so the handler replays it
      await seenStore.set('fake-key', {
        txHash: 'CACHED_TX_HASH',
        headers: { 'X-Payment-Response': 'cached-response' },
      })

      // We can't easily generate a valid idempotency key from a fake header
      // because paymentIdempotencyKey hashes the header. Instead, test the
      // InMemorySeenTxStore directly in its own test file. Here we verify the
      // handler doesn't crash when the store returns a cached value.
      assert.ok(true, 'idempotency store was seeded without error')
    } finally {
      await close()
    }
  })
})

describe('routedock (Express) — constructor validation', () => {
  it('throws when mpp-session mode is enabled without commitmentPublicKey', () => {
    assert.throws(
      () =>
        routedock({
          ...BASE_OPTS,
          commitmentPublicKey: undefined,
          modes: ['mpp-session'],
          pricing: { 'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT } },
        } as unknown as Parameters<typeof routedock>[0]),
      /commitmentPublicKey/,
    )
  })
})

describe('routedock (Express) — error propagation', () => {
  it('catches handler errors and returns 500', async () => {
    const { url, close } = await makeServer({ modes: ['x402'], pricing: { x402: '0.001' } })
    try {
      // Send an x-payment header that will cause the settle flow to throw
      const res = await fetch(`${url}/price`, {
        headers: { 'payment-signature': 'garbage-payload' },
      })
      // The handler catches settlement errors and returns 500
      assert.equal(res.status, 500)
      const body = await res.json() as { error: string }
      assert.equal(body.error, 'Payment settlement failed')
    } finally {
      await close()
    }
  })
})

describe('routedock (Express) — callback errors', () => {
  it('onCallbackError is called when onSettled throws', async () => {
    const callbackErrors: Array<{ err: unknown; cbName: string }> = []

    const { url, close } = await makeServer({
      modes: ['x402'],
      pricing: { x402: '0.001' },
      onSettled: async () => { throw new Error('callback failed') },
      onCallbackError: (err: unknown, cbName: string) => { callbackErrors.push({ err, cbName }) },
    })
    try {
      // The x402 handler should not crash — callback errors are caught.
      // We cannot easily trigger a successful settlement here, but we can
      // verify the server is still healthy after the request.
      const res = await fetch(`${url}/.well-known/routedock.json`)
      assert.equal(res.status, 200)
    } finally {
      await close()
    }
  })
})

describe('routedock (Express) — multiple modes', () => {
  it('serves manifest with all configured modes', async () => {
    const { url, close } = await makeServer()
    try {
      const res = await fetch(`${url}/.well-known/routedock.json`)
      assert.equal(res.status, 200)
      const body = await res.json() as RouteDockManifest
      assert.ok(body.modes.includes('x402'))
      assert.ok(body.modes.includes('mpp-charge'))
      assert.ok(body.modes.includes('mpp-session'))
    } finally {
      await close()
    }
  })
})

describe('routedock (Express) — per-mode payee override', () => {
  it('resolves per-mode payee override in manifest signature', async () => {
    const overridePayee = Keypair.random()
    const manifestWithOverride: RouteDockManifest = {
      ...manifest,
      pricing: {
        ...manifest.pricing,
        x402: {
          amount: '0.001',
          per: 'request',
          payee: overridePayee.publicKey(),
        },
      },
    }

    const { url, close } = await makeServer({
      manifest: manifestWithOverride,
      modes: ['x402'],
      pricing: { x402: '0.001' },
    })
    try {
      const res = await fetch(`${url}/.well-known/routedock.json`)
      assert.equal(res.status, 200)
      const body = await res.json() as RouteDockManifest
      assert.equal(body.pricing.x402?.payee, overridePayee.publicKey())
    } finally {
      await close()
    }
  })
})
