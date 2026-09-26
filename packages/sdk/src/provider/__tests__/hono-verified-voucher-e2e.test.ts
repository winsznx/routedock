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
    // onVerifiedCredential/withTypedChannelErrors honestly.
    stellar: (): Method.AnyServer =>
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

function hexToBytesLocal(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
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
}): Hono {
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
      ...handlers,
    }),
  )
  app.get('/price', (c) => c.json({ price: '42' }))
  return app
}

describe('routedockHono — real HTTP regression coverage for verified-only voucher state (#388)', () => {
  it('a crafted header with an unverified signature never reaches onVoucher/onSessionOpen; only a genuinely verified voucher does', async () => {
    const voucherCalls: Array<{ amount: string; signature: string }> = []
    const sessionOpens: Array<string | null> = []
    const app = buildApp({
      onVoucher: async (_id, _idx, amount, signature) => { voucherCalls.push({ amount, signature }) },
      onSessionOpen: async (_id, payer) => { sessionOpens.push(payer) },
    })

    // Crafted, unverified credential (fails the fake channel verify).
    const badHeader = buildVoucherHeader({ amount: '9999999', signature: BAD_SIGNATURE })
    const badRes = await app.request('/price', { method: 'GET', headers: { authorization: badHeader } })
    assert.equal(badRes.status, 402)
    assert.equal(voucherCalls.length, 0, 'a failed verification must never call onVoucher')
    assert.equal(sessionOpens.length, 0, 'a failed verification must never call onSessionOpen')

    // A genuinely verified voucher.
    const goodHeader = buildVoucherHeader({ amount: '5000', signature: 'ab'.repeat(64) })
    const goodRes = await app.request('/price', { method: 'GET', headers: { authorization: goodHeader } })
    assert.equal(goodRes.status, 200)
    assert.equal(voucherCalls.length, 1)
    assert.equal(voucherCalls[0]?.amount, '0.0005000')
    assert.equal(voucherCalls[0]?.signature, 'ab'.repeat(64))
    assert.equal(sessionOpens.length, 1)
    assert.equal(sessionOpens[0], null)

    // DELETE must close with exactly the verified amount/signature, never the
    // crafted 9999999 the failed request tried to introduce.
    const deleteRes = await app.request('/price', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: '5000', signature: 'ab'.repeat(64) }),
    })
    assert.equal(deleteRes.status, 200)
    assert.equal(closeCalls.length, 1)
    assert.equal(closeCalls[0]?.amount, 5000n)
    assert.deepEqual(closeCalls[0]?.signature, hexToBytesLocal('ab'.repeat(64)))
  })

  it('a crafted source on an unverified credential never becomes the payer; only a genuinely verified credential can set it', async () => {
    const sessionOpens: Array<string | null> = []
    const app = buildApp({
      onSessionOpen: async (_id, payer) => { sessionOpens.push(payer) },
    })

    const crafted = Keypair.random()
    const badHeader = buildVoucherHeader(
      { amount: '1000', signature: BAD_SIGNATURE },
      crafted.publicKey(),
    )
    const badRes = await app.request('/price', { method: 'GET', headers: { authorization: badHeader } })
    assert.equal(badRes.status, 402)
    assert.equal(sessionOpens.length, 0, 'an unverified source must never reach onSessionOpen')

    const goodHeader = buildVoucherHeader(
      { amount: '1000', signature: 'aa'.repeat(64) },
      payerKeypair.publicKey(),
    )
    const goodRes = await app.request('/price', { method: 'GET', headers: { authorization: goodHeader } })
    assert.equal(goodRes.status, 200)
    assert.equal(sessionOpens.length, 1)
    assert.equal(sessionOpens[0], payerKeypair.publicKey())

    // A later verified voucher with a different source must not overwrite the
    // payer already locked in from the first verified voucher.
    const secondHeader = buildVoucherHeader({ amount: '2000', signature: 'bb'.repeat(64) }, crafted.publicKey())
    const secondRes = await app.request('/price', { method: 'GET', headers: { authorization: secondHeader } })
    assert.equal(secondRes.status, 200)
    assert.equal(sessionOpens.length, 1, 'onSessionOpen must only fire once per session')
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
