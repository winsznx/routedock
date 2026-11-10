import { mock, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { Keypair } from '@stellar/stellar-sdk'
import { Challenge, Credential } from 'mppx'
import type { Method } from 'mppx'
import type { RouteDockManifest } from '../../types.js'

const payeeKeypair = Keypair.random()
const commitKeypair = Keypair.random()
const payerA = Keypair.random()
const payerB = Keypair.random()

const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const CHANNEL_A = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'
const CHANNEL_B = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'

let closeCalls: Array<{ channel: string; amount: bigint; signature: Uint8Array }> = []

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
    close: async (opts: { channel: string; amount: bigint; signature: Uint8Array }) => {
      closeCalls.push({ channel: opts.channel, amount: opts.amount, signature: opts.signature })
      return `close-tx-${opts.channel.slice(0, 6)}`
    },
    stellar: (opts: { channel: string; store: { put(key: string, value: unknown): Promise<void> } }): Method.AnyServer =>
      ({
        name: 'stellar',
        intent: 'channel',
        verify: async ({
          credential,
        }: {
          credential: {
            challenge?: { request?: { channel?: unknown } }
            payload?: { signature?: unknown; amount?: unknown }
          }
        }) => {
          const ch =
            typeof credential?.challenge?.request?.channel === 'string' &&
            credential.challenge.request.channel.length > 0
              ? credential.challenge.request.channel
              : opts.channel
          await opts.store.put(`stellar:channel:cumulative:${ch}`, {
            amount: credential?.payload?.amount,
          })
          return { status: 'success' }
        },
      }) as unknown as Method.AnyServer,
  },
})

const actualMppxServer = await import('mppx/server')
mock.module('mppx/server', {
  namedExports: {
    ...actualMppxServer,
    Mppx: {
      create: (config: { methods: Method.AnyServer[] }) => {
        const channelMethod = config.methods[0]!
        return {
          channel:
            (_opts: { amount: string; description?: string }) =>
            async (request: globalThis.Request) => {
              const auth = request.headers.get('authorization')
              if (!auth) {
                return {
                  status: 402,
                  challenge: new Response('Payment Required', { status: 402 }),
                }
              }
              const credential = Credential.deserialize(auth)
              await channelMethod.verify({ credential, request: {} } as Parameters<
                Method.AnyServer['verify']
              >[0])
              return { status: 200 }
            },
        }
      },
    },
  },
})

const { routedockHono } = await import('../hono.js')

const manifest: RouteDockManifest = {
  routedock: '1.0',
  name: 'Multi-Channel Session Test',
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
      channel_factory: CHANNEL_A,
      min_deposit: '0.10',
      refund_waiting_period_ledgers: 17280,
    },
  },
  endpoints: { stream: { method: 'GET', path: '/stream/orderbook' } },
  tags: ['test'],
}

function buildVoucherHeader(
  channel: string,
  payload: { amount: string; signature: string },
  source?: string,
): string {
  const challenge = Challenge.from({
    id: `challenge-${channel}-${payload.amount}`,
    realm: 'test-realm',
    method: 'stellar',
    intent: 'channel',
    request: { amount: '1000', channel },
  })
  const credential = Credential.from({
    challenge,
    payload,
    ...(source ? { source } : {}),
  })
  return Credential.serialize(credential)
}

function createSharedStore() {
  const map = new Map<string, unknown>()
  return {
    map,
    async get(k: string) { return map.get(k) },
    async put(k: string, v: unknown) { map.set(k, v) },
    async delete(k: string) { map.delete(k) },
    update(k: string, fn: (v: unknown) => unknown) { map.set(k, fn(map.get(k))) },
  }
}

describe('routedockHono — multi-channel mpp-session isolation (#550)', () => {
  it('tracks two channels independently in one routedockHono instance, persists under separate keys, and closes only the named channel on DELETE', async () => {
    closeCalls = []
    const sharedStore = createSharedStore()
    const opened: Array<{ channelId: string; payer: string | null }> = []
    const vouchers: Array<{ channelId: string; index: number; amount: string; signature: string }> = []
    const settled: Array<{ txHash: string; amount: string; mode: string; payer: string | null; channelId?: string | undefined }> = []

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
        pricing: { 'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_A } },
        sessionStore: sharedStore as never,
        onSessionOpen: async (channelId, payer) => {
          opened.push({ channelId, payer })
        },
        onVoucher: async (channelId, index, amount, signature) => {
          vouchers.push({ channelId, index, amount, signature })
        },
        onSettled: async (txHash, amount, mode, payer, channelId) => {
          settled.push({ txHash, amount, mode, payer, channelId })
        },
      }),
    )
    app.get('/stream/orderbook', (c) => c.json({ ok: true }))

    const sigA1 = 'aa'.repeat(64)
    const sigA2 = 'ab'.repeat(64)
    const sigB1 = 'bb'.repeat(64)

    // Agent A opens CHANNEL_A and streams 2 vouchers (1000, 2000)
    const resA1 = await app.request('/stream/orderbook', {
      headers: { authorization: buildVoucherHeader(CHANNEL_A, { amount: '1000', signature: sigA1 }, payerA.publicKey()) },
    })
    assert.equal(resA1.status, 200)

    // Agent B opens CHANNEL_B and streams 1 voucher (5000)
    const resB1 = await app.request('/stream/orderbook', {
      headers: { authorization: buildVoucherHeader(CHANNEL_B, { amount: '5000', signature: sigB1 }, payerB.publicKey()) },
    })
    assert.equal(resB1.status, 200)

    // Agent A sends second voucher on CHANNEL_A
    const resA2 = await app.request('/stream/orderbook', {
      headers: { authorization: buildVoucherHeader(CHANNEL_A, { amount: '2000', signature: sigA2 }, payerA.publicKey()) },
    })
    assert.equal(resA2.status, 200)

    await new Promise((r) => setImmediate(r))

    // Both channels fired onSessionOpen once with their respective channel IDs and payers
    assert.equal(opened.length, 2)
    assert.deepEqual(opened[0], { channelId: CHANNEL_A, payer: payerA.publicKey() })
    assert.deepEqual(opened[1], { channelId: CHANNEL_B, payer: payerB.publicKey() })

    // Vouchers are tracked per channel with independent voucher counts
    assert.equal(vouchers.length, 3)
    assert.deepEqual(vouchers[0], { channelId: CHANNEL_A, index: 1, amount: '0.0001000', signature: sigA1 })
    assert.deepEqual(vouchers[1], { channelId: CHANNEL_B, index: 1, amount: '0.0005000', signature: sigB1 })
    assert.deepEqual(vouchers[2], { channelId: CHANNEL_A, index: 2, amount: '0.0002000', signature: sigA2 })

    // Persisted record keys exist independently for both channels
    const persistedA = sharedStore.map.get(`routedock:session:voucher:${CHANNEL_A}`) as Record<string, unknown> | undefined
    const persistedB = sharedStore.map.get(`routedock:session:voucher:${CHANNEL_B}`) as Record<string, unknown> | undefined
    assert.ok(persistedA, 'expected persisted record for CHANNEL_A')
    assert.ok(persistedB, 'expected persisted record for CHANNEL_B')
    assert.equal(persistedA['amount'], '2000')
    assert.equal(persistedA['voucherCount'], 2)
    assert.equal(persistedB['amount'], '5000')
    assert.equal(persistedB['voucherCount'], 1)

    // DELETE naming CHANNEL_B closes ONLY CHANNEL_B and leaves CHANNEL_A intact
    const delB = await app.request('/stream/orderbook', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: CHANNEL_B, amount: '5000', signature: sigB1 }),
    })
    assert.equal(delB.status, 200)
    await new Promise((r) => setImmediate(r))

    assert.equal(closeCalls.length, 1)
    assert.equal(closeCalls[0]!.channel, CHANNEL_B)
    assert.equal(closeCalls[0]!.amount, 5000n)
    assert.equal(settled.length, 1)
    assert.equal(settled[0]!.channelId, CHANNEL_B)
    assert.equal(settled[0]!.payer, payerB.publicKey())

    // CHANNEL_B record is deleted while CHANNEL_A record remains in the store
    assert.equal(sharedStore.map.has(`routedock:session:voucher:${CHANNEL_B}`), false)
    assert.equal(sharedStore.map.has(`routedock:session:voucher:${CHANNEL_A}`), true)

    // Subsequent DELETE for CHANNEL_A settles CHANNEL_A at 2000
    const delA = await app.request('/stream/orderbook', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: CHANNEL_A, amount: '2000', signature: sigA2 }),
    })
    assert.equal(delA.status, 200)
    await new Promise((r) => setImmediate(r))

    assert.equal(closeCalls.length, 2)
    assert.equal(closeCalls[1]!.channel, CHANNEL_A)
    assert.equal(closeCalls[1]!.amount, 2000n)
    assert.equal(settled.length, 2)
    assert.equal(settled[1]!.channelId, CHANNEL_A)
  })
})
