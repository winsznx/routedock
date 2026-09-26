/**
 * Express mpp-session: voucher state (amount, signature, payer) must come
 * only from a credential mppx has actually verified (issue #388). Mirrors
 * hono-verified-voucher.test.ts — same mocking strategy, same assertions,
 * against the Express handler (MppSessionHandler.ts / routedockMiddleware.ts)
 * instead of the Hono one.
 */

import { mock, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import express from 'express'
import type { Request, Response } from 'express'
import { Keypair } from '@stellar/stellar-sdk'
import type { RouteDockManifest } from '../../types.js'

const payeeKeypair = Keypair.random()
const commitKeypair = Keypair.random()
const payerKeypair = Keypair.random()

const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const CHANNEL_CONTRACT = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'

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
    stellar: { channel: () => [] },
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

const { routedock } = await import('../routedockMiddleware.js')

const manifest: RouteDockManifest = {
  routedock: '1.0',
  name: 'Express Verified Voucher Test',
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

/** Boots a real Express server with the mpp-session middleware and returns its URL + the captured `commit`. */
async function makeServer(handlers: {
  onSessionOpen?: (channelId: string, payer: string | null) => Promise<void>
  onVoucher?: (channelId: string, voucherIndex: number, cumulativeAmount: string, signature: string) => Promise<void>
  onOrphaned?: (channelId: string, info: { cumulativeAmount: string; lastSignature: string; voucherCount: number; reason: string }) => Promise<void>
  idleTimeoutMs?: number
} = {}): Promise<{ url: string; commit: Commit; close: () => Promise<void> }> {
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
  app.get('/price', (_req: Request, res: Response) => {
    res.json({ price: '42' })
  })

  assert.ok(lastCommit, 'onVerifiedCredential mock should have captured commit during construction')
  const commit = lastCommit!

  return new Promise((resolve) => {
    const server = createServer(app)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({
        url: `http://127.0.0.1:${port}`,
        commit,
        close: () => new Promise<void>((res) => server.close(() => res())),
      })
    })
  })
}

describe('routedock (Express) — voucher state only from verified credentials', () => {
  it('pairs each committed amount with its own signature (last onVoucher call reflects the latest pair)', async () => {
    const voucherCalls: Array<{ amount: string; signature: string }> = []
    const { commit, close } = await makeServer({
      onVoucher: async (_id, _idx, amount, signature) => {
        voucherCalls.push({ amount, signature })
      },
    })
    try {
      await commit({ payload: { amount: '1000', signature: 'aa'.repeat(32) } })
      await commit({ payload: { amount: '2000', signature: 'bb'.repeat(32) } })

      assert.equal(voucherCalls.length, 2)
      const last = voucherCalls[voucherCalls.length - 1]
    assert.ok(last)
      assert.equal(last.amount, '0.0002000')
      assert.equal(last.signature, 'bb'.repeat(32))
    } finally {
      await close()
    }
  })

  it('captures the payer only from a credential that was actually committed', async () => {
    const sessionOpens: Array<string | null> = []
    const { commit, close } = await makeServer({
      onSessionOpen: async (_id, payer) => { sessionOpens.push(payer) },
    })
    try {
      // No commit call at all simulates a crafted header that failed mppx
      // verification — it cannot influence the payer a later, genuinely
      // verified voucher sets.
      await commit({
        payload: { amount: '1000', signature: 'aa'.repeat(32) },
        source: payerKeypair.publicKey(),
      })
      assert.equal(sessionOpens.length, 1)
      assert.equal(sessionOpens[0], payerKeypair.publicKey())

      await commit({
        payload: { amount: '2000', signature: 'bb'.repeat(32) },
        source: Keypair.random().publicKey(),
      })
      assert.equal(sessionOpens.length, 1, 'onSessionOpen must only fire once per session')
    } finally {
      await close()
    }
  })

  it('a failed verification never calls onVoucher, and a later orphan flag reports the last verified voucher', async () => {
    const voucherCalls: number[] = []
    let orphanInfo: { cumulativeAmount: string; lastSignature: string } | undefined
    const { commit, close } = await makeServer({
      idleTimeoutMs: 30,
      onVoucher: async () => { voucherCalls.push(1) },
      onOrphaned: async (_id, info) => { orphanInfo = info },
    })
    try {
      await commit({ payload: { amount: '1000', signature: 'aa'.repeat(32) } })
      assert.equal(voucherCalls.length, 1)

      // Simulates a later credential that failed mppx verification: commit
      // is simply never invoked for it.
      await new Promise((resolve) => setTimeout(resolve, 150))
      assert.equal(voucherCalls.length, 1, 'onVoucher must not have fired again for the failed verification')
      assert.equal(orphanInfo?.cumulativeAmount, '0.0001000')
      assert.equal(orphanInfo?.lastSignature, 'aa'.repeat(32))
    } finally {
      await close()
    }
  })

  it('DELETE closes with the committed record’s amount and signature', async () => {
    const { url, commit, close } = await makeServer()
    try {
      await commit({ payload: { amount: '5000', signature: 'ff'.repeat(32) } })

      const res = await fetch(`${url}/price`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amount: '5000', signature: 'ff'.repeat(32) }),
      })
      assert.equal(res.status, 200)
      assert.equal(closeCalls.length, 1)
      assert.ok(closeCalls[0])
      assert.equal(closeCalls[0].amount, 5000n)
      assert.deepEqual(closeCalls[0].signature, Buffer.from('ff'.repeat(32), 'hex'))
    } finally {
      await close()
    }
  })
})
