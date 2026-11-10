import { mock, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Hono } from 'hono'
import express from 'express'
import Fastify from 'fastify'
import { Keypair } from '@stellar/stellar-sdk'
import { Challenge, Credential } from 'mppx'
import type { RouteDockManifest } from '../../types.js'

const payeeKeypair = Keypair.random()
const commitKeypair = Keypair.random()

const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const CHANNEL_CONTRACT = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'
const OTHER_CHANNEL = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'

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
      return 'mock-close-tx-hash'
    },
    stellar: Object.assign(() => [], { channel: () => [] }),
  },
})

const actualCompat = await import('../mppCompatibility.js')
type Commit = (credential: { payload?: unknown; source?: string }) => void | Promise<void>
let lastCommit: Commit | null = null

mock.module('../mppCompatibility.js', {
  namedExports: {
    channelAuthorizer: actualCompat.channelAuthorizer,
    withTypedChannelErrors: actualCompat.withTypedChannelErrors,
    formatMppError: actualCompat.formatMppError,
    onVerifiedCredential: (method: unknown, commit: Commit) => {
      lastCommit = commit
      return method
    },
  },
})

const { routedockHono } = await import('../hono.js')
const { routedock } = await import('../routedockMiddleware.js')
const { routedockFastify } = await import('../fastify.js')

const manifest: RouteDockManifest = {
  routedock: '1.0',
  name: 'Delete Auth Test Service',
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

function buildPaymentCredentialHeader(opts: {
  amount: string
  signature: string
  channel?: string
}): string {
  const challenge = Challenge.from({
    id: 'test-challenge-id',
    realm: 'test-realm',
    method: 'stellar',
    intent: 'channel',
    request: opts.channel ? { channel: opts.channel } : {},
  })
  const credential = Credential.from({
    challenge,
    payload: {
      amount: opts.amount,
      signature: opts.signature,
      ...(opts.channel ? { channel: opts.channel } : {}),
    },
  })
  return Credential.serialize(credential)
}

function buildHonoApp(handlers: {
  onSessionOpen?: (channelId: string, payer: string | null) => Promise<void>
  onVoucher?: (channelId: string, voucherIndex: number, cumulativeAmount: string, signature: string) => Promise<void>
} = {}): { app: Hono; commit: Commit } {
  closeCalls = []
  lastCommit = null
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
      ...handlers,
    }),
  )
  app.get('/price', (c) => c.json({ price: '42' }))
  assert.ok(lastCommit, 'onVerifiedCredential mock should have captured commit')
  return { app, commit: lastCommit }
}

describe('routedockHono — DELETE authentication and amount validation (#394)', () => {
  it('rejects an unauthenticated DELETE on a live session with 401 and never calls channelClose', async () => {
    const { app, commit } = buildHonoApp()
    await commit({ payload: { amount: '5000', signature: 'ab'.repeat(64) } })

    const res = await app.request('/price', { method: 'DELETE' })
    assert.equal(res.status, 401)
    assert.equal(closeCalls.length, 0, 'channelClose must not be called on unauthenticated DELETE')
  })

  it('preserves session state after an unauthenticated DELETE so subsequent vouchers continue the same session', async () => {
    const sessionOpens: string[] = []
    const voucherIndices: number[] = []
    const { app, commit } = buildHonoApp({
      onSessionOpen: async (channelId) => { sessionOpens.push(channelId) },
      onVoucher: async (_id, idx) => { voucherIndices.push(idx) },
    })

    await commit({ payload: { amount: '1000', signature: 'aa'.repeat(64) } })
    await new Promise((r) => setImmediate(r))
    assert.equal(sessionOpens.length, 1)
    assert.deepEqual(voucherIndices, [1])

    // Unauthenticated DELETE attempts (bare DELETE and empty JSON body)
    const res1 = await app.request('/price', { method: 'DELETE' })
    assert.equal(res1.status, 401)
    const res2 = await app.request('/price', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    assert.equal(res2.status, 401)
    assert.equal(closeCalls.length, 0)

    // Subsequent authenticated voucher continues the same session (voucherIndex = 2, no duplicate onSessionOpen)
    await commit({ payload: { amount: '2000', signature: 'bb'.repeat(64) } })
    await new Promise((r) => setImmediate(r))
    assert.equal(sessionOpens.length, 1, 'session must not re-open')
    assert.deepEqual(voucherIndices, [1, 2])
  })

  it('closes the open channel when DELETE carries a valid Payment credential header', async () => {
    const { app, commit } = buildHonoApp()
    await commit({ payload: { amount: '5000', signature: 'cd'.repeat(64) } })

    const authHeader = buildPaymentCredentialHeader({
      amount: '5000',
      signature: 'cd'.repeat(64),
      channel: CHANNEL_CONTRACT,
    })
    const res = await app.request('/price', {
      method: 'DELETE',
      headers: { authorization: authHeader },
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { closeTxHash: string }
    assert.equal(body.closeTxHash, 'mock-close-tx-hash')
    assert.equal(closeCalls.length, 1)
    assert.equal(closeCalls[0]?.amount, 5000n)
  })

  it('rejects a DELETE carrying a Payment credential for a different channel without closing', async () => {
    const { app, commit } = buildHonoApp()
    await commit({ payload: { amount: '5000', signature: 'cd'.repeat(64) } })

    const wrongChannelHeader = buildPaymentCredentialHeader({
      amount: '5000',
      signature: 'cd'.repeat(64),
      channel: OTHER_CHANNEL,
    })
    const res = await app.request('/price', {
      method: 'DELETE',
      headers: { authorization: wrongChannelHeader },
    })
    assert.equal(res.status, 401)
    assert.equal(closeCalls.length, 0)
  })

  it('returns 400 JSON error body for decimal, negative, scientific, non-numeric, and non-string amounts', async () => {
    const { app, commit } = buildHonoApp()
    await commit({ payload: { amount: '5000', signature: 'cd'.repeat(64) } })

    for (const badAmount of ['0.5', '-1', '1e3', 'abc', '', 123, null]) {
      const res = await app.request('/price', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amount: badAmount, signature: 'cd'.repeat(64) }),
      })
      assert.equal(res.status, 400, `expected 400 for amount=${JSON.stringify(badAmount)}, got ${res.status}`)
      const json = (await res.json()) as { error?: string }
      assert.ok(typeof json.error === 'string' && json.error.length > 0)
    }
    assert.equal(closeCalls.length, 0)
  })
})

describe('Express and Fastify — DELETE authentication and amount validation (#394)', () => {
  it('Express routedock rejects unauthenticated DELETE on live session (401) and bad amounts (400)', async () => {
    closeCalls = []
    lastCommit = null
    const app = express()
    app.use(express.json())
    app.use(
      routedock({
        asset: 'USDC',
        assetContract: ASSET_CONTRACT,
        payee: payeeKeypair.publicKey(),
        network: 'testnet',
        payeeSecretKey: payeeKeypair.secret(),
        commitmentPublicKey: commitKeypair.publicKey(),
        manifest,
        modes: ['mpp-session'],
        pricing: { 'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT } },
      }),
    )
    app.get('/price', (_req, res) => { res.json({ price: '42' }) })
    const commit = lastCommit as Commit | null
    assert.ok(commit)

    const server = createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as { port: number }).port
    const url = `http://127.0.0.1:${port}/price`

    try {
      await commit({ payload: { amount: '5000', signature: 'ef'.repeat(64) } })

      const unauthRes = await fetch(url, { method: 'DELETE' })
      assert.equal(unauthRes.status, 401)
      assert.equal(closeCalls.length, 0)

      for (const badAmount of ['0.5', '-1', '1e3', 123]) {
        const badRes = await fetch(url, {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ amount: badAmount, signature: 'ef'.repeat(64) }),
        })
        assert.equal(badRes.status, 400)
      }
      assert.equal(closeCalls.length, 0)

      const validRes = await fetch(url, {
        method: 'DELETE',
        headers: {
          authorization: buildPaymentCredentialHeader({
            amount: '5000',
            signature: 'ef'.repeat(64),
            channel: CHANNEL_CONTRACT,
          }),
        },
      })
      assert.equal(validRes.status, 200)
      assert.equal(closeCalls.length, 1)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('Fastify routedockFastify rejects unauthenticated DELETE on live session (401) and bad amounts (400)', async () => {
    closeCalls = []
    lastCommit = null
    const fastify = Fastify()
    await fastify.register(
      routedockFastify({
        asset: 'USDC',
        assetContract: ASSET_CONTRACT,
        payee: payeeKeypair.publicKey(),
        network: 'testnet',
        payeeSecretKey: payeeKeypair.secret(),
        commitmentPublicKey: commitKeypair.publicKey(),
        manifest,
        modes: ['mpp-session'],
        pricing: { 'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT } },
      }),
    )
    fastify.get('/price', async () => ({ price: '42' }))
    const commit = lastCommit as Commit | null
    assert.ok(commit)

    try {
      await commit({ payload: { amount: '5000', signature: 'ef'.repeat(64) } })

      const unauthRes = await fastify.inject({ method: 'DELETE', url: '/price' })
      assert.equal(unauthRes.statusCode, 401)
      assert.equal(closeCalls.length, 0)

      for (const badAmount of ['0.5', '-1', '1e3']) {
        const badRes = await fastify.inject({
          method: 'DELETE',
          url: '/price',
          headers: { 'content-type': 'application/json' },
          payload: JSON.stringify({ amount: badAmount, signature: 'ef'.repeat(64) }),
        })
        assert.equal(badRes.statusCode, 400)
      }
      assert.equal(closeCalls.length, 0)
    } finally {
      await fastify.close()
    }
  })
})
