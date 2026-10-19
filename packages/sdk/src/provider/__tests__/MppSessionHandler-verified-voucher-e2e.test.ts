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
    // Express calls `stellar.channel(...)`, not `stellar(...)` directly. On
    // success this also writes the cumulative amount to the store under the
    // same key real Channel.js uses (@stellar/mpp 0.4.0, Channel.js:288) —
    // the old, pre-fix handler ran its voucher bookkeeping from inside
    // wrappedStore.put on that exact key, so a fake verify that skips this
    // write would make a regression test pass on main for the wrong reason.
    stellar: {
      channel: (opts: { channel: string; store: { put(key: string, value: unknown): Promise<void> } }): Method.AnyServer =>
        ({
          name: 'stellar',
          intent: 'channel',
          verify: async ({
            credential,
          }: {
            credential: { payload?: { signature?: unknown; amount?: unknown } }
          }) => {
            if (credential?.payload?.signature === BAD_SIGNATURE) {
              throw new Error('Commitment signature verification failed.')
            }
            await opts.store.put(`stellar:channel:cumulative:${opts.channel}`, {
              amount: credential?.payload?.amount,
            })
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
        const handler =
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
            }
        return { stellar: { channel: handler } }
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

/**
 * Builds a header in the exact raw form the pre-fix header-parsing code
 * parsed directly off the Authorization header — `Payment credential="<base64
 * of JSON>"` — independent of whatever the real mppx `Credential` codec
 * produces. Real mppx clients never serialize a credential this way (see the
 * issue's scope note), so a test built with `Credential.serialize` never
 * reaches the vulnerable code path at all and would pass even if the old
 * parsing came back. This format is what actually has to be proven harmless.
 */
function buildCraftedHeader(json: Record<string, unknown>): string {
  return `Payment credential="${Buffer.from(JSON.stringify(json)).toString('base64')}"`
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
  app.get('/price', async (_req: Request, res: ExpressResponse) => {
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
  it('closes with the last genuinely verified voucher signature, not a signature from a crafted header in the old, pre-fix format', async () => {
    const voucherCalls: Array<{ amount: string; signature: string }> = []
    const sessionOpens: Array<string | null> = []
    const { url, close } = await makeServer({
      onVoucher: async (_id, _idx, amount, signature) => { voucherCalls.push({ amount, signature }) },
      onSessionOpen: async (_id, payer) => { sessionOpens.push(payer) },
    })
    try {
      // A genuinely verified voucher establishes the record.
      const goodHeader = buildVoucherHeader({ amount: '5000', signature: 'ab'.repeat(64) })
      const goodRes = await fetch(`${url}/price`, { headers: { authorization: goodHeader } })
      assert.equal(goodRes.status, 200)
      assert.equal(voucherCalls.length, 1)
      assert.equal(voucherCalls[0]?.amount, '0.0005000')
      assert.equal(voucherCalls[0]?.signature, 'ab'.repeat(64))
      assert.equal(sessionOpens.length, 1)
      assert.equal(sessionOpens[0], null)

      // A crafted header in the exact raw form the pre-fix code parsed
      // (never a valid mppx credential, so mppx itself rejects it with a 402
      // — the bug was that the header got parsed anyway, before that 402).
      const craftedHeader = buildCraftedHeader({ payload: { signature: 'ff'.repeat(64) } })
      const craftedRes = await fetch(`${url}/price`, { headers: { authorization: craftedHeader } })
      assert.equal(craftedRes.status, 402)
      assert.equal(voucherCalls.length, 1, 'a crafted header must never call onVoucher')

      const deleteRes = await fetch(`${url}/price`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json', authorization: goodHeader },
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

  it('a crafted sender in the old, pre-fix header format never becomes the payer; only a genuinely verified credential can set it', async () => {
    const sessionOpens: Array<string | null> = []
    const { url, close } = await makeServer({
      onSessionOpen: async (_id, payer) => { sessionOpens.push(payer) },
    })
    try {
      // Before any verified voucher, a crafted header in the exact raw form
      // the pre-fix code parsed — it named `sender` directly, ahead of the
      // real, still-unverified voucher below.
      const crafted = Keypair.random()
      const craftedHeader = buildCraftedHeader({
        sender: crafted.publicKey(),
        payload: { signature: 'ff'.repeat(64) },
      })
      const craftedRes = await fetch(`${url}/price`, { headers: { authorization: craftedHeader } })
      assert.equal(craftedRes.status, 402)
      assert.equal(sessionOpens.length, 0, 'a crafted header must never reach onSessionOpen')

      const goodHeader = buildVoucherHeader(
        { amount: '1000', signature: 'aa'.repeat(64) },
        payerKeypair.publicKey(),
      )
      const goodRes = await fetch(`${url}/price`, { headers: { authorization: goodHeader } })
      assert.equal(goodRes.status, 200)
      assert.equal(sessionOpens.length, 1)
      assert.equal(sessionOpens[0], payerKeypair.publicKey(), 'the crafted sender must never win over the genuinely verified payer')

      // Not asserting call count here: a real, separate bug (tracked apart
      // from this PR) can call onSessionOpen more than once on the Express
      // adapter for reasons unrelated to header verification. What matters
      // for this issue is that the crafted address never wins, on any call.
      const secondHeader = buildVoucherHeader({ amount: '2000', signature: 'bb'.repeat(64) }, crafted.publicKey())
      const secondRes = await fetch(`${url}/price`, { headers: { authorization: secondHeader } })
      assert.equal(secondRes.status, 200)
      assert.ok(sessionOpens.length >= 1)
      for (const payer of sessionOpens) {
        assert.equal(payer, payerKeypair.publicKey(), 'the crafted sender must never win over the genuinely verified payer, on any onSessionOpen call')
      }
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

})
