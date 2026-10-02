import assert from 'node:assert/strict'
import test from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import type { ClientStellarSigner } from '@x402/stellar'
import { x402HTTPClient } from '@x402/core/client'
import { encodePaymentRequiredHeader } from '@x402/core/http'
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types'
import { X402Client } from '../x402Client.js'
import type { RouteDockManifest } from '../../types.js'
import {
  RouteDockFacilitatorError,
  RouteDockManifestError,
  RouteDockPolicyRejectError,
} from '../../errors.js'

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

const baseRequirements: PaymentRequirements = {
  scheme: 'exact',
  network: 'stellar:testnet',
  asset: manifest.asset_contract,
  amount: '10000',
  payTo: keypair.publicKey(),
  maxTimeoutSeconds: 60,
  extra: { areFeesSponsored: true },
}

function paymentRequiredHeader(accepts: PaymentRequirements[] = [baseRequirements]): string {
  return encodePaymentRequiredHeader({
    x402Version: 2,
    resource: { url: 'https://api.test/paid' },
    accepts,
  })
}

function paymentRequiredResponse(accepts?: PaymentRequirements[]): Response {
  return new Response('payment required', {
    status: 402,
    headers: { 'X-Payment-Requirements': paymentRequiredHeader(accepts) },
  })
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function makePayload(accepted: PaymentRequirements = baseRequirements): PaymentPayload {
  return { x402Version: 2, accepted, payload: {} }
}

/** A signer stub that records (and refuses) auth-entry signing. */
function signerStub(): { signer: ClientStellarSigner; calls: string[] } {
  const calls: string[] = []
  const signer: ClientStellarSigner = {
    address: keypair.publicKey(),
    signAuthEntry: async (entry: string) => {
      calls.push(entry)
      throw new Error('signAuthEntry must not be called')
    },
  }
  return { signer, calls }
}

/** Treasury account set by `pricing.x402.payee`, different from manifest.payee. */
const TREASURY = Keypair.random()

/** A SAC contract other than the one the manifest prices. */
const OTHER_ASSET = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'

function manifestWithPayeeOverride(): RouteDockManifest {
  return {
    ...manifest,
    pricing: {
      ...manifest.pricing,
      x402: { ...manifest.pricing.x402!, payee: TREASURY.publicKey() },
    },
  }
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
        assert.equal(err.message, '402 X-Payment-Requirements header is malformed')
        assert.equal(err.code, 'MANIFEST')
        assert.equal(err.retryable, false)
        assert.ok(err.cause instanceof Error, 'cause should be the original decode error')
        assert.equal((err.cause as Error).message, 'Invalid payment required header')
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
        assert.equal(err.message, '402 X-Payment-Requirements header is malformed')
        assert.equal(err.code, 'MANIFEST')
        assert.equal(err.retryable, false)
        assert.ok(err.cause instanceof SyntaxError, 'cause should be the original SyntaxError')
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

// ── #386: sign at most once per pay() ────────────────────────────────────────

test('X402Client - paid request always 500: signs once, resends identical headers, exhausts retries', async (t) => {
  const client = new X402Client(keypair.secret(), 'testnet', { baseDelayMs: 1, maxDelayMs: 5 })
  const signCalls = t.mock.method(x402HTTPClient.prototype, 'createPaymentPayload', async () =>
    makePayload(),
  )
  const paidHeaders: Array<Record<string, string>> = []
  const originalFetch = globalThis.fetch

  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    if (headers['PAYMENT-SIGNATURE']) {
      paidHeaders.push(headers)
      return new Response('bad', { status: 500 })
    }
    return paymentRequiredResponse()
  }) as typeof fetch

  try {
    await assert.rejects(
      () => client.pay('https://api.test/paid', manifest),
      (err: unknown) => {
        assert.ok(err instanceof RouteDockFacilitatorError)
        assert.equal(err.status, 500)
        return true
      },
    )
    assert.equal(signCalls.mock.callCount(), 1, 'createPaymentPayload called exactly once')
    assert.equal(paidHeaders.length, 4, 'default maxAttempts sends 4 paid requests')
    for (const header of paidHeaders) {
      assert.deepEqual(header, paidHeaders[0], 'every paid request carries identical headers')
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('X402Client - paid request network failure is retried without re-signing', async (t) => {
  const client = new X402Client(keypair.secret(), 'testnet', { baseDelayMs: 1, maxDelayMs: 5 })
  const signCalls = t.mock.method(x402HTTPClient.prototype, 'createPaymentPayload', async () =>
    makePayload(),
  )
  const paidHeaders: Array<Record<string, string>> = []
  let paidAttempts = 0
  const originalFetch = globalThis.fetch

  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    if (headers['PAYMENT-SIGNATURE']) {
      paidHeaders.push(headers)
      paidAttempts++
      if (paidAttempts === 1) throw new TypeError('fetch failed')
      return jsonResponse({ ok: true })
    }
    return paymentRequiredResponse()
  }) as typeof fetch

  try {
    const result = await client.pay('https://api.test/paid', manifest)
    assert.deepEqual(result.data, { ok: true })
    assert.equal(signCalls.mock.callCount(), 1)
    assert.equal(paidHeaders.length, 2)
    assert.deepEqual(paidHeaders[0], paidHeaders[1])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('X402Client - unpaid probe 503 then 402 is retried, then signs once', async (t) => {
  const client = new X402Client(keypair.secret(), 'testnet', { baseDelayMs: 1, maxDelayMs: 5 })
  const signCalls = t.mock.method(x402HTTPClient.prototype, 'createPaymentPayload', async () =>
    makePayload(),
  )
  let probeAttempts = 0
  let paidRequests = 0
  const originalFetch = globalThis.fetch

  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    if (headers['PAYMENT-SIGNATURE']) {
      paidRequests++
      return jsonResponse({ ok: true })
    }
    probeAttempts++
    if (probeAttempts === 1) return new Response('unavailable', { status: 503 })
    return paymentRequiredResponse()
  }) as typeof fetch

  try {
    const result = await client.pay('https://api.test/paid', manifest)
    assert.deepEqual(result.data, { ok: true })
    assert.equal(probeAttempts, 2)
    assert.equal(paidRequests, 1)
    assert.equal(signCalls.mock.callCount(), 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('X402Client - paid retry returning 402 rejects without a second signature', async (t) => {
  const client = new X402Client(keypair.secret(), 'testnet', { baseDelayMs: 1, maxDelayMs: 5 })
  const signCalls = t.mock.method(x402HTTPClient.prototype, 'createPaymentPayload', async () =>
    makePayload(),
  )
  let paidRequests = 0
  const originalFetch = globalThis.fetch

  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    if (headers['PAYMENT-SIGNATURE']) {
      paidRequests++
      return new Response('payment required again', { status: 402 })
    }
    return paymentRequiredResponse()
  }) as typeof fetch

  try {
    await assert.rejects(
      () => client.pay('https://api.test/paid', manifest),
      (err: unknown) => {
        assert.ok(err instanceof RouteDockManifestError)
        return true
      },
    )
    assert.equal(paidRequests, 1)
    assert.equal(signCalls.mock.callCount(), 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ── #389: bind the unsigned 402 to the signed manifest ───────────────────────

test('X402Client - rejects an inflated challenge before signing', async () => {
  const { signer, calls } = signerStub()
  const client = new X402Client(signer, 'testnet')
  let fetchCount = 0
  const originalFetch = globalThis.fetch

  globalThis.fetch = (async () => {
    fetchCount++
    return paymentRequiredResponse([{ ...baseRequirements, amount: '10000000000' }])
  }) as typeof fetch

  try {
    await assert.rejects(
      () => client.pay('https://api.test/paid', manifest),
      (err: unknown) => {
        assert.ok(err instanceof RouteDockPolicyRejectError)
        assert.equal(err.reason, 'challenge_amount_exceeds_manifest')
        return true
      },
    )
    assert.equal(calls.length, 0, 'signer must never be asked to sign')
    assert.equal(fetchCount, 1, 'no settlement request is sent and nothing retried')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('X402Client - rejects a payee mismatch before signing', async () => {
  const { signer, calls } = signerStub()
  const client = new X402Client(signer, 'testnet')
  let fetchCount = 0
  const originalFetch = globalThis.fetch

  globalThis.fetch = (async () => {
    fetchCount++
    return paymentRequiredResponse([
      { ...baseRequirements, payTo: Keypair.random().publicKey() },
    ])
  }) as typeof fetch

  try {
    await assert.rejects(
      () => client.pay('https://api.test/paid', manifest),
      (err: unknown) => {
        assert.ok(err instanceof RouteDockPolicyRejectError)
        assert.equal(err.reason, 'challenge_payee_mismatch')
        return true
      },
    )
    assert.equal(calls.length, 0)
    assert.equal(fetchCount, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('X402Client - rejects an asset mismatch before signing when the payee is overridden', async () => {
  const { signer, calls } = signerStub()
  const client = new X402Client(signer, 'testnet')
  let fetchCount = 0
  const originalFetch = globalThis.fetch

  globalThis.fetch = (async () => {
    fetchCount++
    return paymentRequiredResponse([
      { ...baseRequirements, payTo: TREASURY.publicKey(), asset: OTHER_ASSET },
    ])
  }) as typeof fetch

  try {
    await assert.rejects(
      () => client.pay('https://api.test/paid', manifestWithPayeeOverride()),
      (err: unknown) => {
        assert.ok(err instanceof RouteDockPolicyRejectError)
        assert.equal(err.reason, 'challenge_asset_mismatch')
        return true
      },
    )
    assert.equal(calls.length, 0, 'signer must never be asked to sign')
    assert.equal(fetchCount, 1, 'no settlement request is sent and nothing retried')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('X402Client - rejects a network mismatch before signing when the payee is overridden', async () => {
  const { signer, calls } = signerStub()
  const client = new X402Client(signer, 'testnet')
  let fetchCount = 0
  const originalFetch = globalThis.fetch

  globalThis.fetch = (async () => {
    fetchCount++
    return paymentRequiredResponse([
      { ...baseRequirements, payTo: TREASURY.publicKey(), network: 'stellar:pubnet' },
    ])
  }) as typeof fetch

  try {
    await assert.rejects(
      () => client.pay('https://api.test/paid', manifestWithPayeeOverride()),
      (err: unknown) => {
        assert.ok(err instanceof RouteDockPolicyRejectError)
        assert.equal(err.reason, 'challenge_network_mismatch')
        return true
      },
    )
    assert.equal(calls.length, 0, 'signer must never be asked to sign')
    assert.equal(fetchCount, 1, 'no settlement request is sent and nothing retried')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('X402Client - rejects the top-level payee when pricing.x402.payee overrides it', async () => {
  const { signer, calls } = signerStub()
  const client = new X402Client(signer, 'testnet')
  let fetchCount = 0
  const originalFetch = globalThis.fetch

  // baseRequirements.payTo is the top-level manifest.payee, which is NOT the
  // per-mode override, so a client comparing the wrong field would sign this.
  globalThis.fetch = (async () => {
    fetchCount++
    return paymentRequiredResponse()
  }) as typeof fetch

  try {
    await assert.rejects(
      () => client.pay('https://api.test/paid', manifestWithPayeeOverride()),
      (err: unknown) => {
        assert.ok(err instanceof RouteDockPolicyRejectError)
        assert.equal(err.reason, 'challenge_payee_mismatch')
        return true
      },
    )
    assert.equal(calls.length, 0, 'signer must never be asked to sign')
    assert.equal(fetchCount, 1, 'no settlement request is sent and nothing retried')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('X402Client - reports the amount actually signed, not the manifest price', async (t) => {
  const client = new X402Client(keypair.secret(), 'testnet')
  t.mock.method(x402HTTPClient.prototype, 'createPaymentPayload', async () =>
    makePayload({ ...baseRequirements, amount: '50000' }),
  )
  const originalFetch = globalThis.fetch

  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    if (headers['PAYMENT-SIGNATURE']) return jsonResponse({ ok: true })
    return paymentRequiredResponse([{ ...baseRequirements, amount: '50000' }])
  }) as typeof fetch

  try {
    const result = await client.pay('https://api.test/paid', manifest)
    assert.equal(result.amount, '0.005')
  } finally {
    globalThis.fetch = originalFetch
  }
})
