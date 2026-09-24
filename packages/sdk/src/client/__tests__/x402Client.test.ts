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

test('X402Client - malformed X-Payment-Requirements (not base64) rejects with RouteDockManifestError', async () => {
  const client = new X402Client(keypair.secret(), 'testnet')
  const originalFetch = globalThis.fetch

  globalThis.fetch = (async () => {
    return new Response('payment required', {
      status: 402,
      headers: { 'X-Payment-Requirements': 'not base64!!' },
    })
  }) as typeof fetch

  try {
    await assert.rejects(
      async () => {
        await client.pay('https://api.test/malformed-header-1', manifest)
      },
      (err: any) => {
        assert.ok(err instanceof RouteDockManifestError, 'should be RouteDockManifestError')
        assert.equal(err.code, 'MANIFEST')
        assert.equal(err.retryable, false)
        assert.ok(err.cause instanceof Error, 'cause should be the original decode error')
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('X402Client - malformed X-Payment-Requirements (base64 of non-JSON) rejects with RouteDockManifestError', async () => {
  const client = new X402Client(keypair.secret(), 'testnet')
  const originalFetch = globalThis.fetch

  globalThis.fetch = (async () => {
    return new Response('payment required', {
      status: 402,
      headers: { 'X-Payment-Requirements': Buffer.from('hello').toString('base64') },
    })
  }) as typeof fetch

  try {
    await assert.rejects(
      async () => {
        await client.pay('https://api.test/malformed-header-2', manifest)
      },
      (err: any) => {
        assert.ok(err instanceof RouteDockManifestError, 'should be RouteDockManifestError')
        assert.equal(err.code, 'MANIFEST')
        assert.equal(err.retryable, false)
        assert.ok(err.cause instanceof Error, 'cause should be the original SyntaxError')
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('X402Client - missing X-Payment-Requirements header still rejects with RouteDockManifestError', async () => {
  const client = new X402Client(keypair.secret(), 'testnet')
  const originalFetch = globalThis.fetch

  globalThis.fetch = (async () => {
    return new Response('payment required', { status: 402 })
  }) as typeof fetch

  try {
    await assert.rejects(
      async () => {
        await client.pay('https://api.test/missing-header', manifest)
      },
      (err: any) => {
        assert.ok(err instanceof RouteDockManifestError, 'should be RouteDockManifestError')
        assert.ok(err.message.includes('missing'), 'message should describe the missing header')
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
