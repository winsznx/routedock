/**
 * Hono mpp-session: a failed channel close must leave orphan state armed so
 * the reconciler can still recover the session (issue #148).
 *
 * This file mocks `@stellar/mpp/channel/server` (Store, close, stellar) and
 * runs in its own process, so the real hono.test.ts is unaffected.
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
    // channelClose broadcast always fails — RPC outage / bad sig / fee failure.
    close: async () => {
      throw new Error('rpc outage')
    },
    // mppChannel: capture the wrapped store so the test can feed a voucher in,
    // and return no methods (the orphan/close paths never use mppx methods).
    stellar: (opts: { store: unknown }) => {
      capturedStore = opts.store as WrappedStore
      return []
    },
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('routedockHono — orphan recovery on failed channel close', () => {
  it('leaves orphan state armed and fires onOrphaned when channelClose rejects', async () => {
    let resolveOrphaned!: () => void
    const orphaned = new Promise<void>((resolve) => {
      resolveOrphaned = resolve
    })
    let orphanInfo: { reason: string } | undefined

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
        idleTimeoutMs: 50,
        onOrphaned: async (_channelId, info) => {
          orphanInfo = info
          resolveOrphaned()
        },
      }),
    )

    // Feed a live voucher so the session is open and the idle timer is armed.
    assert.ok(capturedStore, 'stellar mock should have captured the wrapped store')
    await capturedStore!.put(`stellar:channel:cumulative:${CHANNEL_CONTRACT}`, { amount: '1' })

    // DELETE with a mocked close broadcast that always fails → 500, and the
    // orphan state must remain armed (settledCleanly must NOT be set).
    const res = await app.request('/price', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: '1', signature: 'deadbeef' }),
    })
    assert.equal(res.status, 500)

    // The idle timer is still armed, so the reconciler must be notified.
    await Promise.race([
      orphaned,
      sleep(2000).then(() => {
        assert.fail('onOrphaned never fired after a failed channel close')
      }),
    ])
    assert.equal(orphanInfo?.reason, 'idle-timeout')
  })
})
