/**
 * pay() must refuse a request method the signed manifest never declared for the
 * path, before any signer runs or any request reaches the provider (#761).
 *
 * Run with: pnpm --filter @routedock/routedock test
 */

import { createServer } from 'node:http'
import assert from 'node:assert/strict'
import { Keypair } from '@stellar/stellar-sdk'
import { RouteDockClient } from '../RouteDockClient.js'
import { RouteDockManifestError } from '../../errors.js'
import { signManifest } from '../../manifest/sign.js'
import type { RouteDockManifest } from '../../types.js'

const payee = Keypair.random()

function manifestWith(method: 'GET' | 'POST'): RouteDockManifest & { signature: string } {
  return signManifest(
    {
      routedock: '1.0',
      name: 'Method Mismatch Provider',
      description: 'Declares /infer for a single method',
      modes: ['x402'],
      network: 'testnet',
      asset: 'USDC',
      asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      payee: payee.publicKey(),
      pricing: { x402: { amount: '0.001', per: 'request', facilitator: 'https://channels.openzeppelin.com/x402/testnet' } },
      endpoints: { infer: { method, path: '/infer' } },
      tags: ['test'],
    },
    payee.secret(),
  )
}

/** Serves the manifest and records every other request the provider receives. */
function startProvider(manifest: unknown): Promise<{ url: string; hits: string[]; close: () => Promise<void> }> {
  const hits: string[] = []
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url?.startsWith('/.well-known/routedock.json')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(manifest))
        return
      }
      hits.push(`${req.method} ${req.url}`)
      res.writeHead(402)
      res.end()
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      resolve({
        url: `http://127.0.0.1:${port}`,
        hits,
        close: () => new Promise<void>((r) => server.close(() => r())),
      })
    })
  })
}

// ── Test 1: POST against a GET-only path is refused before any signer or request ──
{
  const provider = await startProvider(manifestWith('GET'))
  try {
    let signerCalls = 0
    const client = new RouteDockClient({
      wallet: Keypair.random(),
      network: 'testnet',
      preSignHook: async () => {
        signerCalls++
        return { approve: true }
      },
    })

    await assert.rejects(
      () =>
        client.pay(`${provider.url}/infer`, {
          forceMode: 'x402',
          request: { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"prompt":"hi"}' },
        }),
      (error: unknown) => {
        assert.ok(error instanceof RouteDockManifestError)
        assert.match(error.message, /\/infer only for GET, but the request uses POST/)
        return true
      },
    )
    assert.equal(signerCalls, 0, 'no signer may run for a method the manifest did not declare')
    assert.deepEqual(provider.hits, [], 'not even the unpaid probe may reach the provider')
    console.log('✓ Test 1: pay() refuses POST on a GET-only path before any signer is called')
  } finally {
    await provider.close()
  }
}

// ── Test 2: estimateCost() with the same request is refused too ─────────────────
{
  const provider = await startProvider(manifestWith('GET'))
  try {
    const client = new RouteDockClient({ wallet: Keypair.random(), network: 'testnet' })
    await assert.rejects(
      () => client.estimateCost(`${provider.url}/infer`, { request: { method: 'POST', body: '{}' } }),
      RouteDockManifestError,
    )
    console.log('✓ Test 2: estimateCost() refuses the undeclared method')
  } finally {
    await provider.close()
  }
}

// ── Test 3: the declared method is accepted past the guard ──────────────────────
{
  const provider = await startProvider(manifestWith('POST'))
  try {
    const client = new RouteDockClient({ wallet: Keypair.random(), network: 'testnet' })
    const estimate = await client.estimateCost(`${provider.url}/infer`, { request: { method: 'POST', body: '{}' } })
    assert.equal(estimate.amount, '0.001')
    console.log('✓ Test 3: a declared method passes the guard')
  } finally {
    await provider.close()
  }
}
