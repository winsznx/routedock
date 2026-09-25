import assert from 'node:assert/strict'
import test from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import { X402Client } from '../x402Client.js'
import type { RouteDockManifest } from '../../types.js'
import { RouteDockFacilitatorError, RouteDockManifestError } from '../../errors.js'

const keypair = Keypair.random()
const manifest: RouteDockManifest = {
  routedock: '1.0',
  name: 'Test Service',
  description: 'Test',
  modes: ['x402'],
  network: 'testnet',
  asset: 'USDC',
  asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
  payee: keypair.publicKey(),
  pricing: {
    x402: {
      amount: '0.01',
      per: 'request',
      facilitator: 'https://facilitator.test',
    },
  },
  endpoints: {},
  tags: ['test'],
}

test('X402Client - free 200 response returns amount: "0"', async () => {
  const client = new X402Client(keypair.secret(), 'testnet')
  const originalFetch = globalThis.fetch

  globalThis.fetch = (async () => {
    return new Response(JSON.stringify({ status: 'ok', free: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch

  try {
    const result = await client.pay('https://api.test/free-endpoint', manifest)
    assert.equal(result.amount, '0')
    assert.equal(result.txHash, null)
    assert.equal(result.mode, 'x402')
    assert.deepEqual(result.data, { status: 'ok', free: true })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('X402Client - non-402 500 error throws httpStatusToError without crashing on json', async () => {
  const client = new X402Client(keypair.secret(), 'testnet')
  const originalFetch = globalThis.fetch

  globalThis.fetch = (async () => {
    return new Response('<html>Internal Error</html>', {
      status: 500,
      headers: { 'Content-Type': 'text/html' },
    })
  }) as typeof fetch

  try {
    await assert.rejects(
      async () => {
        await client.pay('https://api.test/error-endpoint', manifest)
      },
      (err: any) => {
        assert.ok(err instanceof RouteDockFacilitatorError)
        assert.equal(err.status, 500)
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

function mock402(header: Record<string, string>): typeof fetch {
  return (async () => {
    return new Response(JSON.stringify({ error: 'payment required' }), {
      status: 402,
      headers: { 'Content-Type': 'application/json', ...header },
    })
  }) as typeof fetch
}

test('X402Client - 402 with a non-base64 X-Payment-Requirements header throws RouteDockManifestError', async () => {
  const client = new X402Client(keypair.secret(), 'testnet')
  const originalFetch = globalThis.fetch
  globalThis.fetch = mock402({ 'X-Payment-Requirements': 'not base64!!' })

  try {
    await assert.rejects(
      async () => {
        await client.pay('https://api.test/paid-endpoint', manifest)
      },
      (err: any) => {
        assert.ok(err instanceof RouteDockManifestError)
        assert.equal(err.message, '402 X-Payment-Requirements header is malformed')
        assert.ok(err.cause instanceof Error)
        assert.equal((err.cause as Error).message, 'Invalid payment required header')
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('X402Client - 402 with a base64 non-JSON X-Payment-Requirements header throws RouteDockManifestError', async () => {
  const client = new X402Client(keypair.secret(), 'testnet')
  const originalFetch = globalThis.fetch
  globalThis.fetch = mock402({
    'X-Payment-Requirements': Buffer.from('hello').toString('base64'),
  })

  try {
    await assert.rejects(
      async () => {
        await client.pay('https://api.test/paid-endpoint', manifest)
      },
      (err: any) => {
        assert.ok(err instanceof RouteDockManifestError)
        assert.equal(err.message, '402 X-Payment-Requirements header is malformed')
        assert.ok(err.cause instanceof SyntaxError)
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
