/**
 * mpp-session orphan detection on Express and Fastify (#714).
 *
 * mpp-session over HTTP is one request per voucher. Node >= 16 emits 'close'
 * on IncomingMessage when a request completes normally, so listening on the
 * request flagged every live session orphaned after each paid response. The
 * handler now listens on the response and only flags a response that was cut
 * off (!writableFinished).
 *
 * These run against real http.createServer / fastify.listen sockets (not
 * inject: light-my-request does not emit Node's real close semantics). Mock
 * setup mirrors MppSessionHandler-verified-voucher-e2e.test.ts.
 */

import { mock, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import express from 'express'
import type { Request, Response as ExpressResponse } from 'express'
import Fastify from 'fastify'
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
const { routedockFastify } = await import('../fastify.js')

const manifest: RouteDockManifest = {
  routedock: '1.0',
  name: 'Orphan Close Test',
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

type Orphan = { cumulativeAmount: string; voucherCount: number; reason: string }

const providerOpts = (onOrphaned: (id: string, info: Orphan) => Promise<void>) =>
  ({
    asset: 'USDC',
    assetContract: ASSET_CONTRACT,
    payee: payeeKeypair.publicKey(),
    network: 'testnet',
    payeeSecretKey: payeeKeypair.secret(),
    commitmentPublicKey: commitKeypair.publicKey(),
    manifest,
    modes: ['mpp-session'],
    pricing: { 'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT } },
    onOrphaned,
  }) as never

interface Harness {
  url: string
  orphans: Orphan[]
  /** Resolves once the route handler has started a response that is held open. */
  held: Promise<void>
  /** Make the next /price response stay open after writing its first chunk. */
  holdNext: () => void
  close: () => Promise<void>
}

function holdState() {
  let hold = false
  const open: Array<() => void> = []
  let onHeld: () => void = () => {}
  let held = new Promise<void>((r) => { onHeld = r })
  return {
    shouldHold: () => { const h = hold; hold = false; return h },
    registerRelease: (fn: () => void) => { open.push(fn); onHeld() },
    holdNext: () => { hold = true; held = new Promise<void>((r) => { onHeld = r }) },
    getHeld: () => held,
    releaseAll: () => { while (open.length) open.pop()!() },
  }
}

async function makeExpress(): Promise<Harness> {
  const orphans: Orphan[] = []
  const hs = holdState()
  const app = express()
  app.use(routedock(providerOpts(async (_id, info) => { orphans.push(info) })))
  app.get('/price', (_req: Request, res: ExpressResponse) => {
    if (hs.shouldHold()) {
      res.write('partial')
      hs.registerRelease(() => res.end())
      return
    }
    res.json({ price: '42' })
  })
  const server: Server = createServer(app)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    orphans,
    get held() { return hs.getHeld() },
    holdNext: hs.holdNext,
    close: async () => {
      hs.releaseAll()
      server.closeAllConnections()
      await new Promise<void>((r) => server.close(() => r()))
    },
  }
}

async function makeFastify(): Promise<Harness> {
  const orphans: Orphan[] = []
  const hs = holdState()
  const fastify = Fastify()
  await fastify.register(routedockFastify(providerOpts(async (_id, info) => { orphans.push(info) })))
  fastify.get('/price', async (_request, reply) => {
    if (hs.shouldHold()) {
      reply.hijack()
      reply.raw.writeHead(200)
      reply.raw.write('partial')
      hs.registerRelease(() => reply.raw.end())
      return reply
    }
    return { price: '42' }
  })
  const url = await fastify.listen({ port: 0, host: '127.0.0.1' })
  return {
    url,
    orphans,
    get held() { return hs.getHeld() },
    holdNext: hs.holdNext,
    close: async () => {
      hs.releaseAll()
      fastify.server.closeAllConnections()
      await fastify.close()
    },
  }
}

const settle = () => new Promise((r) => setTimeout(r, 100))

for (const [name, make] of [['Express', makeExpress], ['Fastify', makeFastify]] as const) {
  describe(`${name} mpp-session orphan detection (#714)`, () => {
    it('three sequential paid requests never call onOrphaned', async () => {
      const h = await make()
      try {
        for (let i = 1; i <= 3; i++) {
          const header = buildVoucherHeader({ amount: String(i * 1000), signature: 'ab'.repeat(64) })
          const res = await fetch(`${h.url}/price`, { headers: { authorization: header } })
          assert.equal(res.status, 200)
          await res.text()
          await settle()
        }
        assert.deepEqual(h.orphans, [])
      } finally {
        await h.close()
      }
    })

    it('a client abort before the response finishes calls onOrphaned once with connection-closed', async () => {
      const h = await make()
      try {
        // A first, normal voucher opens the session.
        const first = await fetch(`${h.url}/price`, {
          headers: { authorization: buildVoucherHeader({ amount: '1000', signature: 'ab'.repeat(64) }) },
        })
        await first.text()
        await settle()
        assert.deepEqual(h.orphans, [])

        h.holdNext()
        const ac = new AbortController()
        const pending = fetch(`${h.url}/price`, {
          headers: { authorization: buildVoucherHeader({ amount: '2000', signature: 'cd'.repeat(64) }) },
          signal: ac.signal,
        }).then((r) => r.text()).catch(() => undefined)
        await h.held
        ac.abort()
        await pending
        await settle()

        const got: Orphan[] = [...h.orphans]
        assert.equal(got.length, 1)
        assert.equal(got[0]?.reason, 'connection-closed')
        assert.equal(got[0]?.cumulativeAmount, '0.0002000')
      } finally {
        await h.close()
      }
    })
  })
}
