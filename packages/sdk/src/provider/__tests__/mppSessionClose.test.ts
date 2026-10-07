/** Regression coverage for MPP session close amount/signature selection (#374). */
import { mock, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { Keypair } from '@stellar/stellar-sdk'
import type { RouteDockManifest } from '../../types.js'

const payeeKeypair = Keypair.random()
const commitKeypair = Keypair.random()
const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const CHANNEL_CONTRACT = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'
const TRACKED_SIGNATURE = 'ab'.repeat(64)
const CLIENT_SIGNATURE = 'cd'.repeat(64)
type CapturedStore = { put: (key: string, value: unknown) => Promise<void> }
let capturedStore: CapturedStore | null = null
let closeCalls: Array<{ amount: bigint; signature: Uint8Array }> = []

mock.module('@stellar/mpp/channel/server', { namedExports: {
  Store: { memory: () => { const values = new Map<string, unknown>(); return { get: async (k: string) => values.get(k), put: async (k: string, v: unknown) => values.set(k, v), delete: async (k: string) => values.delete(k), update: async (k: string, fn: (v: unknown) => unknown) => values.set(k, fn(values.get(k))) } } },
  close: async (args: { amount: bigint; signature: Uint8Array }) => { closeCalls.push(args); return 'CLOSE_TX_HASH' },
  stellar: (opts: { store: unknown }) => { capturedStore = opts.store as CapturedStore; return [] },
} })
mock.module('mppx/server', { namedExports: {
  Expires: {}, Store: {}, Request: {}, Response: {}, Transport: {}, NodeListener: {}, stripe: {}, tempo: {},
  Mppx: { create: () => ({ channel: () => async (request: Request) => request.headers.get('authorization')?.startsWith('Payment ') ? { status: 200 } : { status: 402, challenge: new Response('Payment Required', { status: 402 }) } }) },
} })

const { routedockHono } = await import('../hono.js')
const manifest: RouteDockManifest = {
  routedock: '1.0', name: 'Test Service', description: 'Unit test provider', modes: ['mpp-session'], network: 'testnet', asset: 'USDC', asset_contract: ASSET_CONTRACT, payee: payeeKeypair.publicKey(),
  pricing: { 'mpp-session': { rate: '0.0001', per: 'voucher', channel_factory: CHANNEL_CONTRACT, min_deposit: '0.10', refund_waiting_period_ledgers: 17280 } }, endpoints: { stream: { method: 'GET', path: '/stream' } }, tags: ['test'],
}
function makeApp(onSettled: (amount: string) => void = () => undefined) {
  const app = new Hono()
  app.use('*', routedockHono({ modes: ['mpp-session'], pricing: { 'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT } }, asset: 'USDC', assetContract: ASSET_CONTRACT, payee: payeeKeypair.publicKey(), network: 'testnet', payeeSecretKey: payeeKeypair.secret(), commitmentPublicKey: commitKeypair.publicKey(), manifest, onSettled: async (_hash, amount) => onSettled(amount) }))
  app.get('/stream', (c) => c.json({ ok: true }))
  return app
}
function paymentHeader(signature: string): string { return `Payment credential=${Buffer.from(JSON.stringify({ payload: { signature } })).toString('base64url')}` }
async function seed(amount: string): Promise<void> { assert.ok(capturedStore); await capturedStore!.put(`stellar:channel:cumulative:${CHANNEL_CONTRACT}`, { amount }) }

describe('routedockHono — mpp-session DELETE close', () => {
  it('uses the highest tracked voucher and its signature over a lower client amount', async () => {
    closeCalls = []; const settled: string[] = []; const app = makeApp((amount) => settled.push(amount))
    await app.request('/stream', { headers: { authorization: paymentHeader(TRACKED_SIGNATURE) } }); await seed('5000')
    const res = await app.request('/stream', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amount: '1000', signature: CLIENT_SIGNATURE }) })
    assert.equal(res.status, 200); assert.equal((await res.json() as { closeTxHash: string }).closeTxHash, 'CLOSE_TX_HASH'); assert.equal(closeCalls[0]!.amount, 5000n); assert.deepEqual(Buffer.from(closeCalls[0]!.signature), Buffer.from(TRACKED_SIGNATURE, 'hex')); await new Promise((resolve) => setImmediate(resolve)); assert.deepEqual(settled, ['0.0005000'])
  })
  it('uses a higher client amount and client signature when it exceeds tracked state', async () => {
    closeCalls = []; const app = makeApp(); await seed('5000'); await app.request('/stream', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amount: '9000', signature: CLIENT_SIGNATURE }) }); assert.equal(closeCalls[0]!.amount, 9000n); assert.deepEqual(Buffer.from(closeCalls[0]!.signature), Buffer.from(CLIENT_SIGNATURE, 'hex'))
  })
  it('can close from an equal client amount when no voucher signature was tracked', async () => {
    closeCalls = []; const app = makeApp(); await seed('5000'); await app.request('/stream', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amount: '5000', signature: CLIENT_SIGNATURE }) }); assert.equal(closeCalls[0]!.amount, 5000n)
  })
  it('does not close a lower client amount when no provider signature was tracked', async () => {
    closeCalls = []; const app = makeApp(); await seed('5000'); const res = await app.request('/stream', { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amount: '1000', signature: CLIENT_SIGNATURE }) }); assert.equal((await res.json() as { closeTxHash: null }).closeTxHash, null); assert.equal(closeCalls.length, 0)
  })
})
