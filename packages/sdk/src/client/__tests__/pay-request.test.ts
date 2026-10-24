/**
 * End-to-end tests for the `request` option on RouteDockClient.pay().
 *
 * Unlike the per-client unit tests, these drive the public pay() entry point
 * against a real local HTTP server so the request actually travels through
 * manifest resolution, mode selection and the x402 probe/settle cycle.
 *
 * Run with: pnpm --filter @routedock/routedock test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Keypair } from '@stellar/stellar-sdk'
import { encodePaymentRequiredHeader } from '@x402/core/http'
import { RouteDockClient } from '../RouteDockClient.js'
import { signManifest } from '../../manifest/sign.js'
import type { RouteDockManifest, PaymentResult } from '../../types.js'

const PAYEE = Keypair.random()

function buildManifest(): RouteDockManifest & { signature: string } {
  return signManifest(
    {
      routedock: '1.0',
      name: 'POST Payment Test Provider',
      description: 'Provider exercised by the pay(request) end-to-end tests',
      modes: ['x402', 'mpp-charge'],
      network: 'testnet',
      asset: 'USDC',
      asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      payee: PAYEE.publicKey(),
      pricing: {
        x402: {
          amount: '0.001',
          per: 'request',
          facilitator: 'https://channels.openzeppelin.com/x402/testnet',
        },
        'mpp-charge': { amount: '0.0008', per: 'request' },
      },
      endpoints: { infer: { method: 'POST', path: '/infer' } },
      tags: ['inference'],
    },
    PAYEE.secret(),
  )
}

const paymentRequired = {
  x402Version: 2,
  resource: { url: 'https://provider.test/infer' },
  accepts: [
    {
      scheme: 'exact',
      network: 'stellar:testnet' as const,
      asset: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      amount: '10000',
      payTo: PAYEE.publicKey(),
      maxTimeoutSeconds: 60,
      extra: {},
    },
  ],
}

interface RecordedRequest {
  method: string
  path: string
  headers: Headers
  body: string
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Serve the signed manifest and a POST /infer endpoint that returns a 402
 * challenge until a payment header is present, then echoes the request body.
 */
function startProvider(
  manifest: RouteDockManifest & { signature: string },
): Promise<{ url: string; requests: RecordedRequest[]; close: () => Promise<void> }> {
  const requests: RecordedRequest[] = []

  return new Promise((resolve) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const body = await readBody(req)
      const path = new URL(req.url ?? '/', 'http://localhost').pathname
      requests.push({
        method: req.method ?? 'GET',
        path,
        headers: new Headers(req.headers as Record<string, string>),
        body,
      })

      if (path === '/.well-known/routedock.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(manifest))
        return
      }

      if (path === '/infer' && req.method === 'POST') {
        if (!req.headers['payment-signature']) {
          res.writeHead(402, {
            'X-Payment-Requirements': encodePaymentRequiredHeader(paymentRequired),
          })
          res.end()
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ echoed: body }))
        return
      }

      res.writeHead(404)
      res.end()
    })

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise<void>((done) => server.close(() => done())),
      })
    })
  })
}

/** Replace real x402 signing — only HTTP propagation is under test. */
function stubX402Signing(client: RouteDockClient): void {
  ;(client as any)._checkTrustline = async () => {}
  ;(client as any).x402.httpClient = {
    createPaymentPayload: async () => ({
      x402Version: 2,
      resource: paymentRequired.resource,
      accepted: paymentRequired.accepts[0],
      payload: { signature: 'fake' },
    }),
    encodePaymentSignatureHeader: () => ({ 'PAYMENT-SIGNATURE': 'sdk-payment' }),
  }
}

test('RouteDockClient.pay() sends POST and the body on the x402 probe and paid request', async () => {
  const provider = await startProvider(buildManifest())
  try {
    const client = new RouteDockClient({ wallet: Keypair.random(), network: 'testnet' })
    stubX402Signing(client)

    const body = JSON.stringify({ prompt: 'hello' })
    const result = await client.pay(`${provider.url}/infer`, {
      forceMode: 'x402',
      request: {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-trace-id': 'trace-1' },
        body,
      },
    })

    assert.deepEqual(result.data, { echoed: body })

    const inferRequests = provider.requests.filter((request) => request.path === '/infer')
    assert.equal(inferRequests.length, 2, 'expected a probe and a paid request')
    for (const [index, request] of inferRequests.entries()) {
      assert.equal(request.method, 'POST', `request ${index + 1} must use POST`)
      assert.equal(request.body, body, `request ${index + 1} must carry the body`)
      assert.equal(request.headers.get('content-type'), 'application/json')
      assert.equal(request.headers.get('x-trace-id'), 'trace-1')
    }
    assert.equal(inferRequests[0]!.headers.get('payment-signature'), null)
    assert.equal(inferRequests[1]!.headers.get('payment-signature'), 'sdk-payment')
  } finally {
    await provider.close()
  }
})

test('RouteDockClient.pay() forwards the request to mpp-charge', async () => {
  const provider = await startProvider(buildManifest())
  try {
    const client = new RouteDockClient({ wallet: Keypair.random(), network: 'testnet' })
    ;(client as any)._checkTrustline = async () => {}

    const captured: Array<{ url: string; request?: unknown }> = []
    const fakeResult: PaymentResult = {
      data: { ok: true },
      txHash: null,
      mode: 'mpp-charge',
      amount: '0.0008',
      timestamp: Date.now(),
    }
    ;(client as any).charge = {
      pay: async (url: string, _manifest: RouteDockManifest, request?: unknown) => {
        captured.push(request === undefined ? { url } : { url, request })
        return fakeResult
      },
    }

    const request = { method: 'POST', body: JSON.stringify({ prompt: 'hi' }) }
    const result = await client.pay(`${provider.url}/infer`, {
      forceMode: 'mpp-charge',
      request,
    })

    assert.equal(result.mode, 'mpp-charge')
    assert.equal(captured.length, 1)
    assert.equal(captured[0]!.url, `${provider.url}/infer`)
    assert.deepEqual(captured[0]!.request, request)
  } finally {
    await provider.close()
  }
})

test('RouteDockClient.pay() defaults to an undefined request', async () => {
  const provider = await startProvider(buildManifest())
  try {
    const client = new RouteDockClient({ wallet: Keypair.random(), network: 'testnet' })
    ;(client as any)._checkTrustline = async () => {}

    const captured: Array<unknown> = []
    ;(client as any).x402 = {
      pay: async (_url: string, _manifest: RouteDockManifest, request?: unknown) => {
        captured.push(request)
        return {
          data: { ok: true },
          txHash: null,
          mode: 'x402',
          amount: '0.001',
          timestamp: Date.now(),
        } satisfies PaymentResult
      },
    }

    await client.pay(`${provider.url}/infer`, { forceMode: 'x402' })
    assert.deepEqual(captured, [undefined])
  } finally {
    await provider.close()
  }
})
