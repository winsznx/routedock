/** Integration coverage for the real manifest timeout path. */
import * as http from 'node:http'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import { fetchManifest } from '../ModeRouter.js'
import { RouteDockClient } from '../RouteDockClient.js'
import { RouteDockManifestTimeoutError } from '../../errors.js'

function startHangingServer(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const sockets = new Set<import('node:net').Socket>()
    const server = http.createServer(() => undefined)
    server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((done) => { for (const socket of sockets) socket.destroy(); server.close(() => done()) }) })
    })
  })
}

test('fetchManifest wraps a hanging provider in RouteDockManifestTimeoutError', async () => {
  const server = await startHangingServer()
  try {
    await assert.rejects(() => fetchManifest(server.url, { maxAttempts: 1 }, 150), (err: unknown) => err instanceof RouteDockManifestTimeoutError && err.code === 'MANIFEST_TIMEOUT' && /150ms/.test(err.message))
  } finally { await server.close() }
})

test('RouteDockClient propagates manifestTimeoutMs through estimateCost', async () => {
  const server = await startHangingServer()
  try {
    const client = new RouteDockClient({ wallet: Keypair.random().secret(), network: 'testnet', manifestTimeoutMs: 150, retryPolicy: { maxAttempts: 1 } })
    await assert.rejects(() => client.estimateCost(`${server.url}/price`), (err: unknown) => err instanceof RouteDockManifestTimeoutError)
  } finally { await server.close() }
})
