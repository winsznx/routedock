/** Express adapter regression coverage for MPP session close (#374). */
import { mock, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import express from 'express'
import { Keypair } from '@stellar/stellar-sdk'
import type { RouteDockManifest } from '../../types.js'

const payeeKeypair = Keypair.random(); const commitKeypair = Keypair.random()
const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'; const CHANNEL_CONTRACT = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'; const TRACKED_SIGNATURE = 'ab'.repeat(64); const CLIENT_SIGNATURE = 'cd'.repeat(64)
type CapturedStore = { put: (key: string, value: unknown) => Promise<void> }; let capturedStore: CapturedStore | null = null; let closeCalls: Array<{ amount: bigint; signature: Buffer }> = []
mock.module('@stellar/mpp/channel/server', { namedExports: { Store: { memory: () => { const values = new Map<string, unknown>(); return { get: async (k: string) => values.get(k), put: async (k: string, v: unknown) => values.set(k, v), delete: async (k: string) => values.delete(k), update: async (k: string, fn: (v: unknown) => unknown) => values.set(k, fn(values.get(k))) } } }, close: async (args: { amount: bigint; signature: Buffer }) => { closeCalls.push(args); return 'EXPRESS_CLOSE_HASH' }, stellar: { channel: (opts: { store: unknown }) => { capturedStore = opts.store as CapturedStore; return {} } } } })
mock.module('mppx/server', { namedExports: {
  Expires: {}, Store: {}, Response: {}, Transport: {}, NodeListener: {}, stripe: {}, tempo: {},
  Mppx: { create: () => ({ channel: () => async () => ({ status: 200 }) }) },
  Request: { fromNodeListener: (req: unknown) => req },
} })
const { routedock } = await import('../routedockMiddleware.js')
const manifest: RouteDockManifest = { routedock: '1.0', name: 'Express Test Service', description: 'Unit test provider', modes: ['mpp-session'], network: 'testnet', asset: 'USDC', asset_contract: ASSET_CONTRACT, payee: payeeKeypair.publicKey(), pricing: { 'mpp-session': { rate: '0.0001', per: 'voucher', channel_factory: CHANNEL_CONTRACT, min_deposit: '0.10', refund_waiting_period_ledgers: 17280 } }, endpoints: { stream: { method: 'GET', path: '/stream' } }, tags: ['test'] }
async function makeServer() { const app = express(); app.use(express.json()); app.use(routedock({ modes: ['mpp-session'], pricing: { 'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT } }, asset: 'USDC', assetContract: ASSET_CONTRACT, payee: payeeKeypair.publicKey(), network: 'testnet', payeeSecretKey: payeeKeypair.secret(), commitmentPublicKey: commitKeypair.publicKey(), manifest })); app.get('/stream', (_req, res) => res.json({ ok: true })); const server = createServer(app); await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); const addr = server.address() as { port: number }; return { url: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) } }
async function seed(amount: string) { assert.ok(capturedStore); await capturedStore!.put(`stellar:channel:cumulative:${CHANNEL_CONTRACT}`, { amount }) }
const trackedAuth = `Payment credential=${Buffer.from(JSON.stringify({ payload: { signature: TRACKED_SIGNATURE } })).toString('base64')}`
describe('routedock (Express) — mpp-session DELETE close', () => {
  it('uses the tracked voucher when the client sends a lower amount', async () => { closeCalls = []; const server = await makeServer(); try { await fetch(`${server.url}/stream`, { headers: { authorization: trackedAuth } }); await seed('5000'); const res = await fetch(`${server.url}/stream`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amount: '1000', signature: CLIENT_SIGNATURE }) }); assert.equal(res.status, 200); assert.equal((await res.json() as { closeTxHash: string }).closeTxHash, 'EXPRESS_CLOSE_HASH'); assert.equal(closeCalls[0]!.amount, 5000n); assert.deepEqual(closeCalls[0]!.signature, Buffer.from(TRACKED_SIGNATURE, 'hex')) } finally { await server.close() } })
  it('uses the higher client amount and signature when it exceeds tracked state', async () => { closeCalls = []; const server = await makeServer(); try { await seed('5000'); await fetch(`${server.url}/stream`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amount: '9000', signature: CLIENT_SIGNATURE }) }); assert.equal(closeCalls[0]!.amount, 9000n); assert.deepEqual(closeCalls[0]!.signature, Buffer.from(CLIENT_SIGNATURE, 'hex')) } finally { await server.close() } })
})
