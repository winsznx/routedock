/**
 * Hono mpp-charge / mpp-session: unexpected errors must go through the
 * configured logger and return the same JSON 500 shape as the x402 handler,
 * instead of propagating to Hono's plain-text default error handler (#559).
 *
 * Mocks `mppx/server`, `@stellar/mpp/*` and mppCompatibility so the failure
 * branches can be driven without a live chain. Runs in its own process.
 */

import { mock, describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { Keypair } from '@stellar/stellar-sdk'
import type { RouteDockManifest } from '../../types.js'
import type { RouteDockLogger, RouteDockLogFields } from '../../internal/logger.js'

const payeeKeypair = Keypair.random()
const commitKeypair = Keypair.random()

const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const CHANNEL_CONTRACT = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'

mock.module('@stellar/mpp/charge/server', {
  namedExports: { stellar: () => [] },
})

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
    // The close broadcast always fails.
    close: async () => {
      throw new Error('rpc outage')
    },
    stellar: () => [],
  },
})

// The mppx handlers (charge + channel) reject, as on an mppx / Store failure.
mock.module('mppx/server', {
  namedExports: {
    Mppx: {
      create: () => ({
        'stellar/charge': () => async () => {
          throw new Error('mppx charge failure')
        },
        channel: () => async () => {
          throw new Error('mppx channel failure')
        },
      }),
    },
  },
})

// Capture `commit` so a verified voucher can be fed in (see hono-orphan-close).
const actualCompat = await import('../mppCompatibility.js')
let capturedCommit: ((credential: unknown) => void | Promise<void>) | null = null
mock.module('../mppCompatibility.js', {
  namedExports: {
    channelAuthorizer: actualCompat.channelAuthorizer,
    withTypedChannelErrors: actualCompat.withTypedChannelErrors,
    formatMppError: actualCompat.formatMppError,
    onVerifiedCredential: (
      method: unknown,
      commit: (credential: unknown) => void | Promise<void>,
    ) => {
      capturedCommit = commit
      return method
    },
  },
})

const { routedockHono } = await import('../hono.js')

const manifest: RouteDockManifest = {
  routedock: '1.0',
  name: 'Mpp Error Handling Test',
  description: 'Unit test provider',
  modes: ['mpp-charge', 'mpp-session'],
  network: 'testnet',
  asset: 'USDC',
  asset_contract: ASSET_CONTRACT,
  payee: payeeKeypair.publicKey(),
  pricing: {
    'mpp-charge': { amount: '0.001', per: 'request' },
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

let logCalls: Array<{ level: string; message: string; fields?: RouteDockLogFields | undefined }> = []
const logger: RouteDockLogger = (level, message, fields) => {
  logCalls.push({ level, message, fields })
}

function makeApp(mode: 'mpp-charge' | 'mpp-session'): Hono {
  const app = new Hono()
  app.use(
    '*',
    routedockHono({
      ...BASE_OPTS,
      modes: [mode],
      pricing:
        mode === 'mpp-charge'
          ? { 'mpp-charge': '0.001' }
          : { 'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT } },
      logger,
    }),
  )
  app.get('/price', (c) => c.json({ ok: true }))
  return app
}

async function assertJson500(res: Response, error: string): Promise<void> {
  assert.equal(res.status, 500)
  assert.match(res.headers.get('content-type') ?? '', /application\/json/)
  assert.deepEqual(await res.json(), { error })
}

describe('routedockHono — mpp error handling', () => {
  beforeEach(() => {
    logCalls = []
    capturedCommit = null
  })

  it('mpp-charge: a failing mppx handler logs once and returns a JSON 500', async () => {
    const res = await makeApp('mpp-charge').request('/price')
    await assertJson500(res, 'Payment settlement failed')
    assert.equal(logCalls.length, 1)
    assert.equal(logCalls[0]!.level, 'error')
    assert.equal((logCalls[0]!.fields?.error as Error).message, 'mppx charge failure')
  })

  it('mpp-session: a failing mppx handler logs once and returns a JSON 500', async () => {
    const res = await makeApp('mpp-session').request('/price')
    await assertJson500(res, 'Session payment failed')
    assert.equal(logCalls.length, 1)
    assert.equal(logCalls[0]!.level, 'error')
    assert.equal((logCalls[0]!.fields?.error as Error).message, 'mppx channel failure')
  })

  it('mpp-session: a failing channelClose on DELETE logs once and returns a JSON 500', async () => {
    const app = makeApp('mpp-session')
    assert.ok(capturedCommit, 'onVerifiedCredential mock should have captured commit')
    await capturedCommit!({ payload: { amount: '1', signature: 'deadbeef' } })
    logCalls = []

    const res = await app.request('/price', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: '1', signature: 'deadbeef' }),
    })
    await assertJson500(res, 'Session payment failed')
    assert.equal(logCalls.length, 1)
    assert.equal(logCalls[0]!.level, 'error')
    assert.equal((logCalls[0]!.fields?.error as Error).message, 'rpc outage')
  })

  
})
