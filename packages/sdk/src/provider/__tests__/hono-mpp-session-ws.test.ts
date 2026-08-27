/**
 * Hono mpp-session-ws: voucher verification, WebSocket upgrade flagging, and
 * channel close for the WebSocket transport variant (#78).
 *
 * This file mocks `@stellar/mpp/channel/server` (Store, close, stellar) and
 * `mppx/server` so the verified path can be exercised without a real Soroban
 * channel — it runs in its own process, so the real hono.test.ts is unaffected
 * (same pattern as hono-orphan-close.test.ts).
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

type WrappedStore = { put: (key: string, value: unknown) => Promise<void> }
let capturedStore: WrappedStore | null = null
let settleCalls: Array<{ txHash: string; mode: string }> = []

mock.module('@stellar/mpp/channel/server', {
  namedExports: {
    Store: {
      memory: () => {
        const m = new Map<string, unknown>()
        return {
          async get(k: string) {
            return m.get(k)
          },
          async put(k: string, v: unknown) {
            m.set(k, v)
          },
          async delete(k: string) {
            m.delete(k)
          },
          update(k: string, fn: (v: unknown) => unknown) {
            m.set(k, fn(m.get(k)))
          },
        }
      },
    },
    // Channel close broadcast succeeds in these tests.
    close: async () => 'CLOSE_TX_HASH',
    // mppChannel: capture the wrapped store so tests can feed vouchers in.
    stellar: (opts: { store: unknown }) => {
      capturedStore = opts.store as WrappedStore
      return []
    },
  },
})

mock.module('mppx/server', {
  namedExports: {
    // @stellar/mpp re-exports these from mppx/server; every name the real
    // module exports must be present here or the importing module fails to
    // link with "does not provide an export named ...", even though no test
    // in this file touches them.
    Expires: {},
    Store: {},
    Request: {},
    Response: {},
    Transport: {},
    NodeListener: {},
    stripe: {},
    tempo: {},
    Mppx: {
      create: () => ({
        // Fake channel verification: no Payment credential → 402 challenge,
        // valid Payment credential → verified.
        channel: (_opts: { amount: string }) => async (request: Request) => {
          const auth = request.headers.get('authorization')
          if (!auth?.startsWith('Payment ')) {
            return {
              status: 402,
              challenge: new Response('Payment Required', {
                status: 402,
                headers: {
                  'www-authenticate':
                    'Payment id="test", realm="test", method="stellar", intent="channel", request="e30"',
                },
              }),
            }
          }
          return { status: 200 }
        },
      }),
    },
  },
})

const { routedockHono, MPP_SESSION_WS_VERIFIED, mppSessionWsVerified } = await import('../hono.js')

const manifest: RouteDockManifest = {
  routedock: '1.0',
  name: 'Test WS Service',
  description: 'Unit test provider',
  modes: ['mpp-session-ws'],
  network: 'testnet',
  asset: 'USDC',
  asset_contract: ASSET_CONTRACT,
  payee: payeeKeypair.publicKey(),
  pricing: {
    'mpp-session-ws': {
      rate: '0.0001',
      per: 'voucher',
      channel_factory: CHANNEL_CONTRACT,
      min_deposit: '0.10',
      refund_waiting_period_ledgers: 17280,
    },
  },
  endpoints: { stream: { method: 'GET', path: '/stream/orderbook' } },
  tags: ['test'],
}

function makeApp() {
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
      modes: ['mpp-session-ws'],
      pricing: { 'mpp-session-ws': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT } },
      onSettled: async (txHash, _amount, mode) => {
        settleCalls.push({ txHash, mode })
      },
    }),
  )
  // Stand-in for the app's upgrade route: answers with whether the payment
  // middleware verified the handshake credential.
  app.get('/stream/orderbook', (c) => {
    const ctx = c as unknown as {
      get: (key: string) => unknown
      json: (data: unknown) => Response
    }
    return ctx.json({ verified: ctx.get(MPP_SESSION_WS_VERIFIED) === true })
  })
  return app
}

describe('routedockHono — mpp-session-ws', () => {
  it('returns a 402 challenge for an unauthenticated request', async () => {
    const app = makeApp()
    const res = await app.request('/stream/orderbook', { method: 'GET' })
    assert.equal(res.status, 402)
    const auth = res.headers.get('www-authenticate')
    assert.ok(auth?.startsWith('Payment '), 'expected an mpp Payment challenge')
  })

  it('returns a 402 challenge for an unauthenticated WebSocket handshake', async () => {
    const app = makeApp()
    const res = await app.request('/stream/orderbook', {
      method: 'GET',
      headers: { upgrade: 'websocket', connection: 'Upgrade' },
    })
    assert.equal(res.status, 402)
  })

  it('marks the context verified and hands control to the upgrade route when the credential is valid', async () => {
    const app = makeApp()
    const res = await app.request('/stream/orderbook', {
      method: 'GET',
      headers: {
        upgrade: 'websocket',
        connection: 'Upgrade',
        authorization: 'Payment eyJwYXlsb2FkIjp7ImFjdGlvbiI6InZvdWNoZXIifX0',
      },
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { verified: boolean }
    assert.equal(body.verified, true, 'middleware must set MPP_SESSION_WS_VERIFIED for the upgrade route')
  })

  it('does not set the verified flag for a non-upgrade (SSE-style) request', async () => {
    const app = makeApp()
    const res = await app.request('/stream/orderbook', {
      method: 'GET',
      headers: { authorization: 'Payment eyJwYXlsb2FkIjp7ImFjdGlvbiI6InZvdWNoZXIifX0' },
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { verified: boolean }
    assert.equal(body.verified, false)
  })

  it('closes the channel on DELETE and reports the mpp-session-ws mode', async () => {
    settleCalls = []
    const app = makeApp()
    assert.ok(capturedStore, 'stellar mock should have captured the wrapped store')
    await capturedStore!.put(`stellar:channel:cumulative:${CHANNEL_CONTRACT}`, { amount: '1000' })

    const res = await app.request('/stream/orderbook', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: '1000', signature: 'ab'.repeat(64) }),
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { closeTxHash: string }
    assert.equal(body.closeTxHash, 'CLOSE_TX_HASH')
    assert.equal(settleCalls.length, 1)
    assert.equal(settleCalls[0]!.mode, 'mpp-session-ws')
  })

  it('throws when mpp-session-ws is enabled without commitmentPublicKey', () => {
    assert.throws(
      () =>
        routedockHono({
          asset: 'USDC',
          assetContract: ASSET_CONTRACT,
          payee: payeeKeypair.publicKey(),
          network: 'testnet',
          payeeSecretKey: payeeKeypair.secret(),
          manifest,
          modes: ['mpp-session-ws'],
          pricing: { 'mpp-session-ws': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT } },
        }),
      /commitmentPublicKey/,
    )
  })
})

describe('mppSessionWsVerified helper', () => {
  it('returns true only when the verified flag is set', () => {
    assert.equal(mppSessionWsVerified({ get: () => true }), true)
    assert.equal(mppSessionWsVerified({ get: () => false }), false)
    assert.equal(mppSessionWsVerified({ get: () => 'yes' }), false)
    assert.equal(MPP_SESSION_WS_VERIFIED, 'routedock.mppSessionWs.verified')
  })
})
