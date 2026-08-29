/**
 * Workers smoke test for #243 — the SDK client must not compile validators
 * with `new Function` at module scope, because Cloudflare Workers (and any
 * CSP-restricted runtime) disallow dynamic code generation.
 *
 * This test imports the client entry point while `new Function` is banned and
 * asserts:
 *   1. Module evaluation completes without invoking `new Function`.
 *   2. Manifest fetch + validation still work (via a local mock server).
 */

import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import { signManifest } from '../manifest/sign.js'

/** Replace global Function with a version that throws when used as a constructor. */
function banNewFunction(): () => void {
  const RealFunction = globalThis.Function
  const banned = new Proxy(RealFunction, {
    construct() {
      throw new Error(
        'new Function is disabled in this Workers-like test runtime — module-scope codegen must not be used',
      )
    },
  }) as unknown as typeof globalThis.Function
  globalThis.Function = banned
  return () => {
    globalThis.Function = RealFunction
  }
}

function startTestServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((res) => server.close(() => res())),
      })
    })
  })
}

test('importing the SDK client works under a Workers-like no-new-Function runtime', async () => {
  const restore = banNewFunction()
  try {
    // Cache-bust so module-scope code actually re-executes under the ban.
    const { RouteDockClient, fetchManifest } = await import(
      `../client/index.js?workers-smoke=${Date.now()}`
    )
    assert.equal(typeof RouteDockClient, 'function', 'RouteDockClient should be exported')

    // Manifest validation still functions without dynamic codegen.
    const payeeKp = Keypair.random()
    const signedManifest = signManifest(
      {
        routedock: '1.0',
        name: 'Workers Smoke Provider',
        description: 'Smoke test provider',
        modes: ['x402' as const],
        network: 'testnet',
        asset: 'USDC',
        asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
        payee: payeeKp.publicKey(),
        pricing: {
          x402: {
            amount: '0.001',
            per: 'request',
            facilitator: 'https://channels.openzeppelin.com/x402/testnet',
          },
        },
        endpoints: { price: { method: 'GET', path: '/price' } },
        tags: ['price', 'stellar'],
      },
      payeeKp.secret(),
    )

    const server = await startTestServer((req, res) => {
      if (req.url === '/.well-known/routedock.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(signedManifest))
      } else {
        res.writeHead(404)
        res.end()
      }
    })
    try {
      const manifest = await fetchManifest(server.url)
      assert.equal(manifest.name, 'Workers Smoke Provider', 'manifest should be fetched + validated')
      assert.ok(manifest.modes.includes('x402'))
    } finally {
      await server.close()
    }
  } finally {
    restore()
  }
})
