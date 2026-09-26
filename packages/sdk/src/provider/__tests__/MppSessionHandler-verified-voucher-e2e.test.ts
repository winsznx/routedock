/**
 * Express mpp-session (issue #388, regression coverage requested in review):
 * mirrors hono-verified-voucher-e2e.test.ts against the Express handler
 * (MppSessionHandler.ts / routedockMiddleware.ts). The bookkeeping-level
 * tests in MppSessionHandler-verified-voucher.test.ts mock
 * '../mppCompatibility.js' and call the captured `commit` directly, so they
 * cannot catch a regression that reintroduces pre-verification header
 * parsing — `commit` would simply never be invoked with unverified data in
 * that setup either way.
 *
 * This file drives real HTTP requests through the real (unmocked)
 * onVerifiedCredential/withTypedChannelErrors from '../mppCompatibility.js',
 * and real Credential.deserialize/Challenge.from/Credential.serialize from
 * 'mppx' to build genuine Authorization headers. '@stellar/mpp/channel/server'
 * is mocked with a fake channel-verify method (rejects a sentinel bad
 * signature, accepts anything else); 'mppx/server' keeps its real
 * Request.fromNodeListener (needed to turn the Express req into a fetch
 * Request) and only replaces Mppx.create with a fake `channel()` that runs
 * real Credential.deserialize and then calls straight into the real, wrapped
 * channel method's `verify` — exactly as production code does.
 */

import { mock, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import express from 'express'
import type { Request, Response as ExpressResponse } from 'express'
import { Keypair } from '@stellar/stellar-sdk'
import { Credential, Challenge } from 'mppx'
import type { Method } from 'mppx'
import type { RouteDockManifest } from '../../types.js'

const payeeKeypair = Keypair.random()
const commitKeypair = Keypair.random()
const payerKeypair = Keypair.random()

const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const CHANNEL_CONTRACT = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'

/** Sentinel signature the fake channel-verify method treats as invalid. */
const BAD_SIGNATURE = 'bad-signature-sentinel'

let closeCalls: Array<{ amount: bigint; signature: Buffer }> = []

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
    close: async (opts: { amount: bigint; signature: Buffer }) => {
      closeCalls.push({ amount: opts.amount, signature: opts.signature })
      return 'mock-close-tx-hash'
    },
    // Express calls `stellar.channel(...)`, not `stellar(...)` directly.
    stellar: {
      channel: (): Method.AnyServer =>
        ({
          name: 'stellar',
          intent: 'channel',
          verify: async ({ credential }: { credential: { payload?: { signature?: unknown } } }) => {
            if (credential?.payload?.signature === BAD_SIGNATURE) {
              throw new Error('Commitment signature verification failed.')
            }
            return { status: 'success' }
          },
        }) as unknown as Method.AnyServer,
    },
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
              if (!auth) return { status: 402, challenge: buildChallengeResponse() }
              let credential
              try {
                credential = Credential.deserialize(auth)
              } catch {
                return { status: 402, challenge: buildChallengeResponse() }
              }
              try {
                await channelMethod.verify({ credential, request: {} } as Parameters<
                  Method.AnyServer['verify']
                >[0])
                return { status: 200 }
              } catch {
                return { status: 402, challenge: buildChallengeResponse() }
              }
            },
        }
      },
    },
  },
})

function buildChallengeResponse(): Response {
  const challenge = Challenge.from({
    id: 'test-challenge-id',
    realm: 'test-realm',
    method: 'stellar',
    intent: 'channel',
    request: {},
  })
  return new Response('Payment Required', {
    status: 402,
    headers: { 'www-authenticate': Challenge.serialize(challenge) },
  })
}

/** Builds a genuine `Payment ...` Authorization header via the real mppx Credential codec. */
function buildVoucherHeader(payload: { amount: string; signature: string }, source?: string): string {
  const challenge = Challenge.from({
    id: 'test-challenge-id',
    realm: 'test-realm',
    method: 'stellar',
    intent: 'channel',
    request: {},
  })
  const credential = Credential.from({
    challenge,
    payload,
    ...(source ? { source } : {}),
  })
  return Credential.serialize(credential)
}

const { routedock } = await import('../routedockMiddleware.js')

const manifest: RouteDockManifest = {
  routedock: '1.0',
  name: 'Express Verified Voucher E2E Test',
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

/** Boots a real Express server with the mpp-session middleware. */
async function makeServer(handlers: {
  onSessionOpen?: (channelId: string, payer: string | null) => Promise<void>
  onVoucher?: (channelId: string, voucherIndex: number, cumulativeAmount: string, signature: string) => Promise<void>
  onOrphaned?: (channelId: string, info: { cumulativeAmount: string; lastSignature: string; voucherCount: number; reason: string }) => Promise<void>
  idleTimeoutMs?: number
} = {}): Promise<{ url: string; close: () => Promise<void> }> {
  closeCalls = []
  const app = express()
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
      ...handlers,
    } as Parameters<typeof routedock>[0]),
  )
  app.get('/price', async (req: Request, res: ExpressResponse) => {
    // Test hook only: lets a test delay the final response just long enough
    // to abort the connection while the orphan-detection listener (armed
    // once verification succeeds, before this route runs) is live.
    if (req.header('x-test-delay-ms')) {
      await new Promise((resolve) => setTimeout(resolve, Number(req.header('x-test-delay-ms'))))
    }
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

describe('routedock (Express) — real HTTP regression coverage for verified-only voucher state (#388)', () => {
  it('a crafted header with an unverified signature never reaches onVoucher/onSessionOpen; only a genuinely verified voucher does', async () => {
    const voucherCalls: Array<{ amount: string; signature: string }> = []
    const sessionOpens: Array<string | null> = []
    const { url, close } = await makeServer({
      onVoucher: async (_id, _idx, amount, signature) => { voucherCalls.push({ amount, signature }) },
      onSessionOpen: async (_id, payer) => { sessionOpens.push(payer) },
    })
    try {
      const badHeader = buildVoucherHeader({ amount: '9999999', signature: BAD_SIGNATURE })
      const badRes = await fetch(`${url}/price`, { headers: { authorization: badHeader } })
      assert.equal(badRes.status, 402)
      assert.equal(voucherCalls.length, 0, 'a failed verification must never call onVoucher')
      assert.equal(sessionOpens.length, 0, 'a failed verification must never call onSessionOpen')

      const goodHeader = buildVoucherHeader({ amount: '5000', signature: 'ab'.repeat(64) })
      const goodRes = await fetch(`${url}/price`, { headers: { authorization: goodHeader } })
      assert.equal(goodRes.status, 200)
      assert.equal(voucherCalls.length, 1)
      assert.equal(voucherCalls[0]?.amount, '0.0005000')
      assert.equal(voucherCalls[0]?.signature, 'ab'.repeat(64))
      assert.equal(sessionOpens.length, 1)
      assert.equal(sessionOpens[0], null)

      const deleteRes = await fetch(`${url}/price`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amount: '5000', signature: 'ab'.repeat(64) }),
      })
      assert.equal(deleteRes.status, 200)
      assert.equal(closeCalls.length, 1)
      assert.equal(closeCalls[0]?.amount, 5000n)
      assert.deepEqual(closeCalls[0]?.signature, Buffer.from('ab'.repeat(64), 'hex'))
    } finally {
      await close()
    }
  })

  it('a crafted source on an unverified credential never becomes the payer; only a genuinely verified credential can set it', async () => {
    const sessionOpens: Array<string | null> = []
    const { url, close } = await makeServer({
      onSessionOpen: async (_id, payer) => { sessionOpens.push(payer) },
    })
    try {
      const crafted = Keypair.random()
      const badHeader = buildVoucherHeader(
        { amount: '1000', signature: BAD_SIGNATURE },
        crafted.publicKey(),
      )
      const badRes = await fetch(`${url}/price`, { headers: { authorization: badHeader } })
      assert.equal(badRes.status, 402)
      assert.equal(sessionOpens.length, 0, 'an unverified source must never reach onSessionOpen')

      const goodHeader = buildVoucherHeader(
        { amount: '1000', signature: 'aa'.repeat(64) },
        payerKeypair.publicKey(),
      )
      const goodRes = await fetch(`${url}/price`, { headers: { authorization: goodHeader } })
      assert.equal(goodRes.status, 200)
      assert.equal(sessionOpens.length, 1)
      assert.equal(sessionOpens[0], payerKeypair.publicKey())

      const secondHeader = buildVoucherHeader({ amount: '2000', signature: 'bb'.repeat(64) }, crafted.publicKey())
      const secondRes = await fetch(`${url}/price`, { headers: { authorization: secondHeader } })
      assert.equal(secondRes.status, 200)
      assert.equal(sessionOpens.length, 1, 'onSessionOpen must only fire once per session')
    } finally {
      await close()
    }
  })

  it('a well-formed but wrong-signature credential is rejected by real verification, and a later orphan flag reports only the last genuinely verified voucher', async () => {
    const voucherCalls: number[] = []
    let orphanInfo: { cumulativeAmount: string; lastSignature: string } | undefined
    const { url, close } = await makeServer({
      idleTimeoutMs: 30,
      onVoucher: async () => { voucherCalls.push(1) },
      onOrphaned: async (_id, info) => { orphanInfo = info },
    })
    try {
      const goodHeader = buildVoucherHeader({ amount: '1000', signature: 'aa'.repeat(64) })
      const goodRes = await fetch(`${url}/price`, { headers: { authorization: goodHeader } })
      assert.equal(goodRes.status, 200)
      assert.equal(voucherCalls.length, 1)

      const badHeader = buildVoucherHeader({ amount: '999999', signature: BAD_SIGNATURE })
      const badRes = await fetch(`${url}/price`, { headers: { authorization: badHeader } })
      assert.equal(badRes.status, 402)
      assert.equal(voucherCalls.length, 1, 'onVoucher must not fire for a credential that fails real verification')

      await new Promise((resolve) => setTimeout(resolve, 150))
      assert.equal(orphanInfo?.cumulativeAmount, '0.0001000')
      assert.equal(orphanInfo?.lastSignature, 'aa'.repeat(64))
    } finally {
      await close()
    }
  })

  it('a normal completed request never flags the session orphaned, but a socket destroyed before the response finishes (a real client crash) does', async () => {
    const orphanCalls: Array<{ reason: string }> = []
    const { url, close } = await makeServer({
      onOrphaned: async (_id, info) => { orphanCalls.push(info) },
    })
    try {
      // A normal, fully-completed request must never be mistaken for a
      // dropped connection — Node fires 'close' on the request object after
      // every request-response cycle, not just on a genuine client crash.
      const goodHeader = buildVoucherHeader({ amount: '1000', signature: 'aa'.repeat(64) })
      const firstRes = await fetch(`${url}/price`, { headers: { authorization: goodHeader } })
      assert.equal(firstRes.status, 200)
      await new Promise((resolve) => setTimeout(resolve, 50))
      assert.equal(orphanCalls.length, 0, 'a normally completed request must not flag the session orphaned')

      // A second, genuinely verified request whose downstream route handler
      // is deliberately slow (the orphan-detection listener is armed right
      // after verification succeeds, before the route runs) — abort the
      // client connection while that response is still in flight, simulating
      // a genuine mid-session crash rather than a normal completion.
      const secondHeader = buildVoucherHeader({ amount: '2000', signature: 'bb'.repeat(64) })
      const controller = new AbortController()
      const pending = fetch(`${url}/price`, {
        headers: { authorization: secondHeader, 'x-test-delay-ms': '80' },
        signal: controller.signal,
      }).catch(() => {})
      await new Promise((resolve) => setTimeout(resolve, 10))
      controller.abort()
      await pending

      await new Promise((resolve) => setTimeout(resolve, 200))
      assert.equal(orphanCalls.length, 1, 'a real mid-request disconnect must still flag the session orphaned')
      assert.equal(orphanCalls[0]?.reason, 'connection-closed')
    } finally {
      await close()
    }
  })
})
