/**
 * Per-call `expectedPayee` (issue #729 / #762 review): one client can bind each
 * provider to its own registered payee, and the payment itself (not only a
 * preliminary check) refuses a manifest signed by another key, even when the
 * provider serves different manifests to different requests.
 */
import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import { RouteDockClient } from '../RouteDockClient.js'
import { RouteDockSignatureError } from '../../errors.js'
import { signManifest } from '../../manifest/sign.js'

function manifestFor(key: Keypair) {
  return signManifest(
    {
      routedock: '1.0',
      name: 'Per-call payee provider',
      description: 'per-call expectedPayee test',
      modes: ['x402'],
      network: 'testnet',
      asset: 'USDC',
      asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      payee: key.publicKey(),
      pricing: { x402: { amount: '0.001', per: 'request', facilitator: 'https://channels.openzeppelin.com/x402/testnet' } },
      endpoints: { price: { method: 'GET', path: '/price' } },
      tags: [],
    },
    key.secret(),
  )
}

function serve(docs: unknown[]): Promise<{ url: string; close: () => Promise<void> }> {
  let served = 0
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(docs[Math.min(served++, docs.length - 1)]))
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      })
    })
  })
}

const newClient = (extra: object = {}) => new RouteDockClient({ wallet: Keypair.random(), network: 'testnet', ...extra })

describe('per-call expectedPayee', () => {
  it('estimateCost rejects a manifest whose payee differs from the call anchor', async () => {
    const provider = Keypair.random()
    const server = await serve([manifestFor(provider)])
    try {
      await assert.rejects(
        newClient().estimateCost(`${server.url}/price`, { expectedPayee: Keypair.random().publicKey() }),
        RouteDockSignatureError,
      )
      const ok = await newClient().estimateCost(`${server.url}/price`, { expectedPayee: provider.publicKey() })
      assert.equal(ok.amount, '0.001')
    } finally {
      await server.close()
    }
  })

  it('overrides the client-wide expectedPayee for that call', async () => {
    const provider = Keypair.random()
    const server = await serve([manifestFor(provider)])
    try {
      const client = newClient({ expectedPayee: Keypair.random().publicKey() })
      await assert.rejects(client.estimateCost(`${server.url}/price`), RouteDockSignatureError)
      const ok = await client.estimateCost(`${server.url}/price`, { expectedPayee: provider.publicKey() })
      assert.equal(ok.amount, '0.001')
    } finally {
      await server.close()
    }
  })

  it('pay() refuses a manifest swapped in after the first request (no-store)', async () => {
    const registered = Keypair.random()
    const attacker = Keypair.random()
    const server = await serve([manifestFor(registered), manifestFor(attacker)])
    try {
      const client = newClient()
      await client.estimateCost(`${server.url}/price`, { expectedPayee: registered.publicKey() })
      await assert.rejects(
        client.pay(`${server.url}/price`, { expectedPayee: registered.publicKey() }),
        RouteDockSignatureError,
      )
    } finally {
      await server.close()
    }
  })

  it('openSession refuses a manifest signed by another key', async () => {
    const server = await serve([manifestFor(Keypair.random())])
    try {
      await assert.rejects(
        newClient({ commitmentSecret: Keypair.random().secret() }).openSession(`${server.url}/stream`, {
          expectedPayee: Keypair.random().publicKey(),
        }),
        RouteDockSignatureError,
      )
    } finally {
      await server.close()
    }
  })
})
