/**
 * Hono mpp-session (issue #388, regression coverage requested in review): the
 * bookkeeping-level tests in hono-verified-voucher.test.ts mock
 * '../mppCompatibility.js' and call the captured `commit` directly, so they
 * cannot catch a regression that reintroduces pre-verification header
 * parsing (the exact bug #388 fixed) — `commit` would simply never be called
 * with unverified data in that setup, verified or not.
 *
 * This file drives real HTTP requests through the real (unmocked)
 * onVerifiedCredential/withTypedChannelErrors from '../mppCompatibility.js',
 * and real Credential.deserialize/Challenge.from/Credential.serialize from
 * 'mppx' to build genuine Authorization headers. Only '@stellar/mpp/channel/server'
 * (the underlying Soroban channel verification) and the outer 'mppx/server'
 * Mppx.create are mocked — the fake channel method's `verify` rejects a
 * sentinel bad signature and accepts anything else, and the fake
 * `Mppx.create().channel()` runs real Credential.deserialize and then calls
 * straight into the real, wrapped channel method's `verify`, exactly as
 * production code does.
 *
 * A crafted header carrying an unverified signature/payer must never reach
 * onVoucher/onSessionOpen or the DELETE-close amount — only a request whose
 * credential this fake verify actually accepts may.
 */

import { mock, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
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
    // A stand-in for the real Soroban channel verification: rejects the
    // sentinel bad signature, accepts anything else. Real enough to exercise
    // onVerifiedCredential/withTypedChannelErrors honestly. On success it also
    // writes the cumulative amount to the store under the same key real
    // Channel.js uses (@stellar/mpp 0.4.0, Channel.js:288) — the old,
    // pre-fix hono.ts ran its voucher bookkeeping from inside wrappedStore.put
    // on that exact key, so a fake verify that skips this write would make a
    // regression test pass on main for the wrong reason (bookkeeping never
    // ran at all) rather than the real one (a crafted header wins the race).
    stellar: (opts: { channel: string; store: { put(key: string, value: unknown): Promise<void> } }): Method.AnyServer =>
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

function hexToBytesLocal(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

/**
 * Builds a header in the exact raw form the pre-fix `extractPayer` parsed
 * directly off the Authorization header — `Payment credential="<base64 of
 * JSON>"` — independent of whatever the real mppx `Credential` codec
 * produces. Real mppx clients never serialize a credential this way (see the
 * issue's scope note), so a test built with `Credential.serialize` never
 * reaches the vulnerable code path at all and would pass even if
 * `extractPayer` came back. This format is what actually has to be proven
 * harmless.
 */
function buildCraftedHeader(json: Record<string, unknown>): string {
  return `Payment credential="${Buffer.from(JSON.stringify(json)).toString('base64')}"`
}

/** A bare in-memory store, usable as `sessionStore` to share state across two independent app instances the way a Durable Object eviction-and-recreate would. */
function createSharedMemoryStore(): { get(k: string): Promise<unknown>; put(k: string, v: unknown): Promise<void>; delete(k: string): Promise<void>; update(k: string, fn: (v: unknown) => unknown): void } {
  const m = new Map<string, unknown>()
  return {
    async get(k: string) { return m.get(k) },
    async put(k: string, v: unknown) { m.set(k, v) },
    async delete(k: string) { m.delete(k) },
    update(k: string, fn: (v: unknown) => unknown) { m.set(k, fn(m.get(k))) },
  }
}

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

function buildApp(handlers: {
  onSessionOpen?: (channelId: string, payer: string | null) => Promise<void>
  onVoucher?: (channelId: string, voucherIndex: number, cumulativeAmount: string, signature: string) => Promise<void>
  onOrphaned?: (channelId: string, info: { cumulativeAmount: string; lastSignature: string; voucherCount: number; reason: string }) => Promise<void>
  idleTimeoutMs?: number
  sessionStore?: ReturnType<typeof createSharedMemoryStore>
}): Hono {
  closeCalls = []
  const { sessionStore, ...rest } = handlers
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
      ...(sessionStore ? { sessionStore: sessionStore as never } : {}),
      ...rest,
    }),
  )
  app.get('/price', (c) => c.json({ price: '42' }))
  return app
}

describe('routedockHono — real HTTP regression coverage for verified-only voucher state (#388)', () => {
  it('closes with the last genuinely verified voucher signature, not a signature from a crafted header in the old, pre-fix format', async () => {
    const voucherCalls: Array<{ amount: string; signature: string }> = []
    const sessionOpens: Array<string | null> = []
    const app = buildApp({
      onVoucher: async (_id, _idx, amount, signature) => { voucherCalls.push({ amount, signature }) },
      onSessionOpen: async (_id, payer) => { sessionOpens.push(payer) },
    })

    // A genuinely verified voucher establishes the record.
    const goodHeader = buildVoucherHeader({ amount: '5000', signature: 'ab'.repeat(64) })
    const goodRes = await app.request('/price', { method: 'GET', headers: { authorization: goodHeader } })
    assert.equal(goodRes.status, 200)
    assert.equal(voucherCalls.length, 1)
    assert.equal(voucherCalls[0]?.amount, '0.0005000')
    assert.equal(voucherCalls[0]?.signature, 'ab'.repeat(64))
    assert.equal(sessionOpens.length, 1)
    assert.equal(sessionOpens[0], null)

    // A crafted header in the exact raw form the pre-fix extractPayer parsed
    // (never a valid mppx credential, so mppx itself rejects it with a 402 —
    // the bug was that extractPayer parsed it anyway, before that 402).
    const craftedHeader = buildCraftedHeader({ payload: { signature: 'ff'.repeat(64) } })
    const craftedRes = await app.request('/price', { method: 'GET', headers: { authorization: craftedHeader } })
    assert.equal(craftedRes.status, 402)
    assert.equal(voucherCalls.length, 1, 'a crafted header must never call onVoucher')

    // DELETE must close with exactly the verified amount/signature, never the
    // crafted signature the failed request tried to introduce.
    const deleteRes = await app.request('/price', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', authorization: goodHeader },
      body: JSON.stringify({ amount: '5000', signature: 'ab'.repeat(64) }),
    })
    assert.equal(deleteRes.status, 200)
    assert.equal(closeCalls.length, 1)
    assert.equal(closeCalls[0]?.amount, 5000n)
    assert.deepEqual(closeCalls[0]?.signature, hexToBytesLocal('ab'.repeat(64)))
  })

  it('a crafted sender in the old, pre-fix header format never becomes the payer; only a genuinely verified credential can set it', async () => {
    const sessionOpens: Array<string | null> = []
    const app = buildApp({
      onSessionOpen: async (_id, payer) => { sessionOpens.push(payer) },
    })

    // Before any verified voucher, a crafted header in the exact raw form the
    // pre-fix extractPayer parsed — it named `sender` directly, ahead of the
    // real, still-unverified voucher below.
    const crafted = Keypair.random()
    const craftedHeader = buildCraftedHeader({
      sender: crafted.publicKey(),
      payload: { signature: 'ff'.repeat(64) },
    })
    const craftedRes = await app.request('/price', { method: 'GET', headers: { authorization: craftedHeader } })
    assert.equal(craftedRes.status, 402)
    assert.equal(sessionOpens.length, 0, 'a crafted header must never reach onSessionOpen')

    const goodHeader = buildVoucherHeader(
      { amount: '1000', signature: 'aa'.repeat(64) },
      payerKeypair.publicKey(),
    )
    const goodRes = await app.request('/price', { method: 'GET', headers: { authorization: goodHeader } })
    assert.equal(goodRes.status, 200)
    assert.equal(sessionOpens.length, 1)
    assert.equal(sessionOpens[0], payerKeypair.publicKey(), 'the crafted sender must never win over the genuinely verified payer')

    // A later verified voucher with a different source must not overwrite the
    // payer already locked in from the first verified voucher.
    const secondHeader = buildVoucherHeader({ amount: '2000', signature: 'bb'.repeat(64) }, crafted.publicKey())
    const secondRes = await app.request('/price', { method: 'GET', headers: { authorization: secondHeader } })
    assert.equal(secondRes.status, 200)
    assert.equal(sessionOpens.length, 1, 'onSessionOpen must only fire once per session')
  })

  it('reads back the persisted record across a fresh instance (simulating eviction) sharing the same session store', async () => {
    const sharedStore = createSharedMemoryStore()

    const appA = buildApp({ sessionStore: sharedStore })
    const voucherHeader = buildVoucherHeader({ amount: '5000', signature: 'cd'.repeat(64) })
    const voucherRes = await appA.request('/price', { method: 'GET', headers: { authorization: voucherHeader } })
    assert.equal(voucherRes.status, 200)

    // A brand-new app instance over the same store — no in-memory `record` of
    // its own — simulating a Durable Object recreated after eviction. A
    // DELETE naming the same amount but a different (wrong) signature must
    // still close with the persisted signature, proving loadPersistedRecord
    // actually reads it back rather than trusting the request body.
    const appB = buildApp({ sessionStore: sharedStore })
    const deleteRes = await appB.request('/price', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', authorization: voucherHeader },
      body: JSON.stringify({ amount: '5000', signature: 'ff'.repeat(64) }),
    })
    assert.equal(deleteRes.status, 200)
    assert.equal(closeCalls.length, 1)
    assert.equal(closeCalls[0]?.amount, 5000n)
    assert.deepEqual(closeCalls[0]?.signature, hexToBytesLocal('cd'.repeat(64)), 'must close with the persisted signature, not the DELETE body’s')
  })

  it('a well-formed but wrong-signature credential is rejected by real verification, and a later orphan flag reports only the last genuinely verified voucher', async () => {
    const voucherCalls: number[] = []
    let orphanInfo: { cumulativeAmount: string; lastSignature: string } | undefined
    const app = buildApp({
      idleTimeoutMs: 30,
      onVoucher: async () => { voucherCalls.push(1) },
      onOrphaned: async (_id, info) => { orphanInfo = info },
    })

    const goodHeader = buildVoucherHeader({ amount: '1000', signature: 'aa'.repeat(64) })
    const goodRes = await app.request('/price', { method: 'GET', headers: { authorization: goodHeader } })
    assert.equal(goodRes.status, 200)
    assert.equal(voucherCalls.length, 1)

    // Well-formed (passes Credential.deserialize) but fails real verify().
    const badHeader = buildVoucherHeader({ amount: '999999', signature: BAD_SIGNATURE })
    const badRes = await app.request('/price', { method: 'GET', headers: { authorization: badHeader } })
    assert.equal(badRes.status, 402)
    assert.equal(voucherCalls.length, 1, 'onVoucher must not fire for a credential that fails real verification')

    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(orphanInfo?.cumulativeAmount, '0.0001000')
    assert.equal(orphanInfo?.lastSignature, 'aa'.repeat(64))
  })
})
