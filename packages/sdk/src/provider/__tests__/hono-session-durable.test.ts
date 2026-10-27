/**
 * Hono mpp-session: a DELETE close must never broadcast below the highest
 * voucher mppx verified for the channel (issue #310).
 *
 * The routedock voucher record is the first line of defence, but a session can
 * have no record at all — it opened before the record existed (an SDK upgrade
 * mid-session), or the record write failed. mppx's own cumulative entry for
 * the channel is still there, so the close path reads it and refuses a lower
 * close with 409 instead of trusting the client's body.
 *
 * The store mock here captures `close` arguments and the session store is a
 * plain Map shared between rebuilt handler instances, the same shape a
 * Durable Object's persistent storage has. Writing a cumulative entry the way
 * mppx does needs no verification: the floor is read from the store directly.
 */

import { mock, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { Keypair } from '@stellar/stellar-sdk'
import type { RouteDockManifest } from '../../types.js'

const payeeKeypair = Keypair.random()
const commitKeypair = Keypair.random()

const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const CHANNEL_CONTRACT = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'

let closeCalls: Array<{ amount: bigint; signature: Uint8Array }> = []

mock.module('@stellar/mpp/channel/server', {
  namedExports: {
    Store: {
      memory: () => {
        const m = new Map<string, unknown>()
        return {
          async get(k: string) { return m.get(k) },
          async put(k: string, v: unknown) { m.set(k, v) },
          async delete(k: string) { m.delete(k) },
          update(k: string, fn: (v: unknown) => unknown) { m.set(k, fn(m.get(k))) },
        }
      },
    },
    close: async (opts: { amount: bigint; signature: Uint8Array }) => {
      closeCalls.push({ amount: opts.amount, signature: opts.signature })
      return 'mock-close-tx-hash'
    },
    stellar: () => [],
  },
})

const { routedockHono } = await import('../hono.js')

const manifest: RouteDockManifest = {
  routedock: '1.0',
  name: 'Test Service',
  description: 'Unit test provider',
  modes: ['mpp-session'],
  network: 'testnet',
  asset: 'USDC',
  asset_contract: ASSET_CONTRACT,
  payee: payeeKeypair.publicKey(),
  pricing: {
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

interface MapStore {
  get: (key: string) => Promise<unknown>
  put: (key: string, value: unknown) => Promise<void>
  delete: (key: string) => Promise<void>
  map: Map<string, unknown>
}

/** A Map-backed durable store shared across rebuilt handler instances. */
function mapStore(): MapStore {
  const m = new Map<string, unknown>()
  return {
    map: m,
    async get(k: string) { return m.get(k) },
    async put(k: string, v: unknown) { m.set(k, v) },
    async delete(k: string) { m.delete(k) },
  }
}

/**
 * Builds a routedockHono app over `store` — a new, independent handler closure
 * just like a rebuilt Durable Object would get.
 */
function buildInstance(store: MapStore): Hono {
  closeCalls = []
  const app = new Hono()
  app.use(
    '*',
    routedockHono({
      asset: 'USDC',
      assetContract: ASSET_CONTRACT,
      payee: payeeKeypair.publicKey(),
      network: 'testnet',
      payeeSecretKey: payeeKeypair.secret(),
      commitmentPublicKey: commitKeypair.publicKey(),
      manifest,
      modes: ['mpp-session'],
      pricing: { 'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT } },
      sessionStore: store,
    }),
  )
  return app
}

const CUMULATIVE_KEY = `stellar:channel:cumulative:${CHANNEL_CONTRACT}`

async function deleteReq(app: Hono, amount: string, signature: string): Promise<Response> {
  return app.request('/price', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ amount, signature }),
  })
}

describe('routedockHono — DELETE close floors at the highest verified voucher (issue #310)', () => {
  it('refuses a close below the stored cumulative entry with 409, with no routedock record', async () => {
    // Sessions opened before the record existed have only mppx's entry: the
    // floor must protect them too.
    const store = mapStore()
    await store.put(CUMULATIVE_KEY, { amount: '5000' })

    const res = await deleteReq(buildInstance(store), '1000', 'deadbeef')

    assert.equal(res.status, 409)
    const json = await res.json() as { closeTxHash: unknown; error?: string }
    assert.equal(json.closeTxHash, null)
    assert.ok(json.error)
    assert.equal(closeCalls.length, 0, 'a close below the floor must never broadcast')
  })

  it('still closes at exactly the stored floor', async () => {
    const store = mapStore()
    await store.put(CUMULATIVE_KEY, { amount: '5000' })

    const res = await deleteReq(buildInstance(store), '5000', 'abcd')

    assert.equal(res.status, 200)
    assert.equal(closeCalls.length, 1)
    assert.equal(closeCalls[0]!.amount, 5000n)
  })

  it('still closes above the stored floor', async () => {
    const store = mapStore()
    await store.put(CUMULATIVE_KEY, { amount: '5000' })

    const res = await deleteReq(buildInstance(store), '6000', 'abcd')

    assert.equal(res.status, 200)
    assert.equal(closeCalls.length, 1)
    assert.equal(closeCalls[0]!.amount, 6000n)
  })

  it('a rebuilt instance closes at the stored record, never below 5000n, with its stored signature', async () => {
    // State a previous instance persisted before eviction: mppx's cumulative
    // entry and routedock's verified-voucher record for the same voucher.
    const store = mapStore()
    await store.put(CUMULATIVE_KEY, { amount: '5000' })
    await store.put(`routedock:session:voucher:${CHANNEL_CONTRACT}`, {
      amount: '5000',
      signature: 'cafe',
      payer: null,
      voucherCount: 5,
      sessionOpened: true,
    })

    const res = await deleteReq(buildInstance(store), '1000', 'deadbeef')

    assert.equal(res.status, 200)
    assert.equal(closeCalls.length, 1)
    assert.equal(closeCalls[0]!.amount, 5000n)
    assert.deepEqual(Array.from(closeCalls[0]!.signature), [0xca, 0xfe])
  })
})
