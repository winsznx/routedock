import assert from 'node:assert/strict'
import test from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import type { ClientStellarSigner } from '@x402/stellar'
import { x402HTTPClient } from '@x402/core/client'
import { encodePaymentRequiredHeader } from '@x402/core/http'
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types'
import { X402Client } from '../x402Client.js'
import type { RouteDockLogFields, RouteDockLogLevel } from '../../internal/logger.js'
import type { RouteDockManifest } from '../../types.js'
import { encodePaymentResponseHeader } from '@x402/core/http'
import {
  RouteDockFacilitatorError,
  RouteDockManifestError,
  RouteDockPaymentRejectedError,
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

const paymentRequired = {
  x402Version: 2,
  resource: { url: 'https://api.test/infer' },
  accepts: [
    {
      scheme: 'exact',
      network: 'stellar:testnet' as const,
      asset: manifest.asset_contract,
      amount: '10000',
      payTo: manifest.payee,
      maxTimeoutSeconds: 60,
      extra: {},
    },
  ],
}

/**
 * Replace the real x402 signing client: building a payment payload needs a
 * live facilitator, and these tests only exercise HTTP request propagation.
 */
function stubSigning(client: X402Client): void {
  ;(client as any).httpClient = {
    createPaymentPayload: async () => ({
      x402Version: 2,
      resource: paymentRequired.resource,
      accepted: paymentRequired.accepts[0],
      payload: { signature: 'fake' },
    }),
    encodePaymentSignatureHeader: () => ({ 'PAYMENT-SIGNATURE': 'sdk-payment' }),
  }
}

function jsonPaymentRequired(): Response {
  return new Response(null, {
    status: 402,
    headers: { 'X-Payment-Requirements': encodePaymentRequiredHeader(paymentRequired) },
  })
}

function jsonOk(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

/** Snapshot a Headers object as a plain record for header comparisons. */
function headerRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {}
  headers.forEach((value, name) => {
    record[name] = value
  })
  return record
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

test('X402Client - POST method and body are replayed on the probe and the paid request', async () => {
  const client = new X402Client(keypair.secret(), 'testnet')
  stubSigning(client)
  const originalFetch = globalThis.fetch
  const calls: Array<{ url: string; init: RequestInit }> = []

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return calls.length === 1 ? jsonPaymentRequired() : jsonOk({ prediction: 42 })
  }) as typeof fetch

  const body = JSON.stringify({ prompt: 'hello' })
  try {
    const result = await client.pay('https://api.test/infer', manifest, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-trace-id': 'trace-1' },
      body,
    })

    assert.deepEqual(result.data, { prediction: 42 })
    assert.equal(calls.length, 2, 'expected one probe and one paid request')

    for (const [index, call] of calls.entries()) {
      assert.equal(call.url, 'https://api.test/infer')
      assert.equal(call.init.method, 'POST', `attempt ${index + 1} must use POST`)
      assert.equal(
        new Headers(call.init.headers).get('content-type'),
        'application/json',
        `attempt ${index + 1} must keep caller headers`,
      )
      assert.equal(
        new Headers(call.init.headers).get('x-trace-id'),
        'trace-1',
        `attempt ${index + 1} must keep caller headers`,
      )
      assert.equal(
        await new Response(call.init.body).text(),
        body,
        `attempt ${index + 1} must send the same body`,
      )
    }

    assert.equal(
      new Headers(calls[0]!.init.headers).get('x-preferred-mode'),
      'x402',
      'probe must carry the SDK mode hint',
    )
    assert.equal(
      new Headers(calls[1]!.init.headers).get('payment-signature'),
      'sdk-payment',
      'paid request must carry the SDK payment header',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('X402Client - caller headers cannot override SDK payment or mode headers', async () => {
  const client = new X402Client(keypair.secret(), 'testnet')
  stubSigning(client)
  const originalFetch = globalThis.fetch
  const calls: RequestInit[] = []

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(init ?? {})
    return calls.length === 1 ? jsonPaymentRequired() : jsonOk({ ok: true })
  }) as typeof fetch

  try {
    await client.pay('https://api.test/infer', manifest, {
      method: 'POST',
      headers: {
        'X-Preferred-Mode': 'mpp-charge',
        'PAYMENT-SIGNATURE': 'caller-forged',
      },
      body: '{}',
    })

    assert.equal(new Headers(calls[0]!.headers).get('x-preferred-mode'), 'x402')
    assert.equal(new Headers(calls[1]!.headers).get('payment-signature'), 'sdk-payment')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('X402Client - retries resend the same buffered body', async () => {
  const client = new X402Client(keypair.secret(), 'testnet', {
    maxAttempts: 2,
    baseDelayMs: 1,
    maxDelayMs: 2,
  })
  stubSigning(client)
  const originalFetch = globalThis.fetch
  const calls: Array<{ method?: string; body: string }> = []

  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    // Drain the body before failing, mimicking a transport that consumed it.
    const body = await new Response(init?.body).text()
    calls.push({ ...(init?.method ? { method: init.method } : {}), body })
    if (calls.length === 1) throw new TypeError('fetch failed')
    return calls.length === 2 ? jsonPaymentRequired() : jsonOk({ ok: true })
  }) as typeof fetch

  const body = JSON.stringify({ prompt: 'retry me' })
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body))
      controller.close()
    },
  })

  try {
    const result = await client.pay('https://api.test/infer', manifest, {
      method: 'POST',
      body: stream,
    })

    assert.deepEqual(result.data, { ok: true })
    assert.equal(calls.length, 3, 'expected a failed attempt, a probe and a paid request')
    assert.deepEqual(
      calls.slice(1).map((call) => call.body),
      [body, body],
      'the probe and retry must send the same bytes as the first attempt',
    )
    assert.ok(calls.every((call) => call.method === 'POST'))
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
    const headers = new Headers(init?.headers)
    if (headers.get('PAYMENT-SIGNATURE')) {
      paidHeaders.push(headerRecord(headers))
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
    const headers = new Headers(init?.headers)
    if (headers.get('PAYMENT-SIGNATURE')) {
      paidHeaders.push(headerRecord(headers))
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
    const headers = new Headers(init?.headers)
    if (headers.get('PAYMENT-SIGNATURE')) {
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
    const headers = new Headers(init?.headers)
    if (headers.get('PAYMENT-SIGNATURE')) {
      paidRequests++
      return new Response('payment required again', { status: 402 })
    }
    return paymentRequiredResponse()
  }) as typeof fetch

  try {
    await assert.rejects(
      () => client.pay('https://api.test/paid', manifest),
      (err: unknown) => {
        assert.ok(err instanceof RouteDockPaymentRejectedError)
        assert.ok(!(err instanceof RouteDockManifestError))
        assert.equal(err.status, 402)
        assert.equal(err.retryable, false)
        return true
      },
    )
    assert.equal(paidRequests, 1)
    assert.equal(signCalls.mock.callCount(), 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ── #558: surface why the provider refused a paid request ────────────────────

/** Drive pay() against a provider whose paid request is answered by `paid()`. */
async function payAgainstRejection(
  t: import('node:test').TestContext,
  paid: () => Response,
): Promise<{ err: unknown; paidRequests: number; signs: number }> {
  const client = new X402Client(keypair.secret(), 'testnet', { baseDelayMs: 1, maxDelayMs: 5 })
  const signCalls = t.mock.method(x402HTTPClient.prototype, 'createPaymentPayload', async () =>
    makePayload(),
  )
  let paidRequests = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    if (headers.get('PAYMENT-SIGNATURE')) {
      paidRequests++
      return paid()
    }
    return paymentRequiredResponse()
  }) as typeof fetch
  try {
    let caught: unknown
    try {
      await client.pay('https://api.test/paid', manifest)
    } catch (e) {
      caught = e
    }
    return { err: caught, paidRequests, signs: signCalls.mock.callCount() }
  } finally {
    globalThis.fetch = originalFetch
  }
}

for (const status of [401, 402]) {
  test(`X402Client - paid ${status} surfaces the provider's reason on RouteDockPaymentRejectedError`, async (t) => {
    const { err, paidRequests, signs } = await payAgainstRejection(t, () =>
      jsonResponse(
        { error: 'Payment verification failed', reason: 'invalid_exact_stellar_payload_wrong_amount' },
        status,
      ),
    )

    assert.ok(err instanceof RouteDockPaymentRejectedError, String(err))
    assert.ok(!(err instanceof RouteDockManifestError), 'a payment rejection is not a manifest error')
    assert.equal(err.code, 'PAYMENT_REJECTED')
    assert.equal(err.status, status)
    assert.equal(err.reason, 'invalid_exact_stellar_payload_wrong_amount')
    assert.equal(err.providerError, 'Payment verification failed')
    assert.equal(err.retryable, false)
    assert.match(err.message, new RegExp(`x402 payment failed: HTTP ${status}`))
    assert.match(err.message, /invalid_exact_stellar_payload_wrong_amount/)
    assert.equal(paidRequests, 1, 'a rejection is not retried')
    assert.equal(signs, 1, 'and never re-signed')
  })
}

test('X402Client - paid rejection without a JSON body still throws RouteDockPaymentRejectedError', async (t) => {
  const { err } = await payAgainstRejection(t, () => new Response('<html>nope</html>', { status: 401 }))

  assert.ok(err instanceof RouteDockPaymentRejectedError, String(err))
  assert.equal(err.status, 401)
  assert.equal(err.reason, undefined)
  assert.equal(err.message, 'x402 payment failed: HTTP 401')
})

test('X402Client - paid rejection with an empty body or odd JSON never throws a parse error', async (t) => {
  for (const body of ['', 'null', '[]', '"just a string"', '{"reason":42}']) {
    const { err } = await payAgainstRejection(t, () => new Response(body, { status: 402 }))
    assert.ok(err instanceof RouteDockPaymentRejectedError, `body ${JSON.stringify(body)}: ${String(err)}`)
    assert.equal(err.reason, undefined)
  }
})

test('X402Client - an oversized provider reason is truncated', async (t) => {
  const { err } = await payAgainstRejection(t, () => jsonResponse({ reason: 'x'.repeat(10_000) }, 402))
  assert.ok(err instanceof RouteDockPaymentRejectedError)
  assert.equal(err.reason?.length, 500)
})

test('X402Client - a rejection body over the read limit is ignored, not parsed', async (t) => {
  const { err } = await payAgainstRejection(t, () =>
    jsonResponse({ reason: 'x'.repeat(100_000) }, 402),
  )
  assert.ok(err instanceof RouteDockPaymentRejectedError)
  assert.equal(err.reason, undefined)
  assert.equal(err.message, 'x402 payment failed: HTTP 402')
})

test('X402Client - paid 5xx is still a retryable facilitator error, not a rejection', async (t) => {
  const { err, paidRequests } = await payAgainstRejection(t, () => new Response('bad', { status: 500 }))
  assert.ok(err instanceof RouteDockFacilitatorError)
  assert.ok(paidRequests > 1, 'server errors are retried')
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
    const headers = new Headers(init?.headers)
    if (headers.get('PAYMENT-SIGNATURE')) return jsonResponse({ ok: true })
    return paymentRequiredResponse([{ ...baseRequirements, amount: '50000' }])
  }) as typeof fetch

  try {
    const result = await client.pay('https://api.test/paid', manifest)
    assert.equal(result.amount, '0.005')
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ── optional pre-sign hook ───────────────────────────────────────────────────

test('X402Client - pre-sign hook rejection aborts before signing', async () => {
  const { signer, calls } = signerStub()
  let seen = 0
  const client = new X402Client(signer, 'testnet', undefined, async (ctx) => {
    seen++
    assert.equal(ctx.url, 'https://api.test/paid')
    assert.equal(ctx.accepts.length, 1)
    return { approve: false, reason: 'looks_injected' }
  })
  let fetchCount = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => {
    fetchCount++
    return paymentRequiredResponse()
  }) as typeof fetch

  try {
    await assert.rejects(
      () => client.pay('https://api.test/paid', manifest),
      (err: unknown) => {
        assert.ok(err instanceof RouteDockPolicyRejectError)
        assert.equal(err.reason, 'looks_injected')
        return true
      },
    )
    assert.equal(seen, 1)
    assert.equal(calls.length, 0, 'signer must never be asked to sign')
    assert.equal(fetchCount, 1, 'no settlement request is sent')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('X402Client - pre-sign hook that throws fails closed before signing', async () => {
  const { signer, calls } = signerStub()
  const client = new X402Client(signer, 'testnet', undefined, () => {
    throw new Error('audit service down')
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => paymentRequiredResponse()) as typeof fetch

  try {
    await assert.rejects(
      () => client.pay('https://api.test/paid', manifest),
      (err: unknown) => {
        assert.ok(err instanceof RouteDockPolicyRejectError)
        assert.equal(err.reason, 'pre_sign_hook_error')
        return true
      },
    )
    assert.equal(calls.length, 0)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('X402Client - approving pre-sign hook runs once and signing proceeds', async (t) => {
  let hookCalls = 0
  const client = new X402Client(keypair.secret(), 'testnet', undefined, () => {
    hookCalls++
    return { approve: true }
  })
  t.mock.method(x402HTTPClient.prototype, 'createPaymentPayload', async () => makePayload())
  t.mock.method(x402HTTPClient.prototype, 'encodePaymentSignatureHeader', () => ({
    'PAYMENT-SIGNATURE': 'sig',
  }))
  let n = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    n++ === 0 ? paymentRequiredResponse() : jsonResponse({ ok: true })) as typeof fetch

  try {
    const result = await client.pay('https://api.test/paid', manifest)
    assert.equal(hookCalls, 1)
    assert.deepEqual(result.data, { ok: true })
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ── #553: a falsy txHash must never be reported as a settlement ─────────────

function settledResponse(body: Record<string, string>): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...body },
  })
}

test('X402Client - paid 200 with empty X-Payment-Response transaction yields null txHash', async (t) => {
  // The exact shape the intermittently-failing E2E runs hit: a provider that
  // served the paid route with a settle result whose `transaction` was "".
  const client = new X402Client(keypair.secret(), 'testnet')
  t.mock.method(x402HTTPClient.prototype, 'createPaymentPayload', async () => makePayload())
  const originalFetch = globalThis.fetch

  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const headers = headerRecord(new Headers(init?.headers))
    if (headers['payment-signature']) {
      return settledResponse({
        'X-Payment-Response': encodePaymentResponseHeader({
          success: true,
          transaction: '',
          network: 'stellar:testnet',
        }),
      })
    }
    return paymentRequiredResponse()
  }) as typeof fetch

  try {
    const result = await client.pay('https://api.test/paid', manifest)
    assert.equal(result.txHash, null, 'empty transaction must normalize to null, not ""')
    assert.equal(result.amount, '0.001', 'a paid request still reports the signed amount')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('X402Client - paid 200 with success: false yields null txHash and logs the reason', async (t) => {
  const lines: Array<{ message: string; fields: RouteDockLogFields | undefined }> = []
  const client = new X402Client(
    keypair.secret(),
    'testnet',
    undefined,
    undefined,
    (_level, message, fields) => lines.push({ message, fields }),
  )
  t.mock.method(x402HTTPClient.prototype, 'createPaymentPayload', async () => makePayload())
  const originalFetch = globalThis.fetch

  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const headers = headerRecord(new Headers(init?.headers))
    if (headers['payment-signature']) {
      return settledResponse({
        'X-Payment-Response': encodePaymentResponseHeader({
          success: false,
          transaction: '',
          network: 'stellar:testnet',
          errorReason: 'settle rejected',
        }),
      })
    }
    return paymentRequiredResponse()
  }) as typeof fetch

  try {
    const result = await client.pay('https://api.test/paid', manifest)
    assert.equal(result.txHash, null)
    const unsettled = lines.find(
      (l) => l.message === '[x402] X-Payment-Response reports an unsettled payment',
    )
    assert.ok(unsettled, 'the unsettled header is logged')
    assert.equal(unsettled?.fields?.reason, 'settle rejected', "the provider's reason survives")
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('X402Client - paid 200 with undecodable X-Payment-Response yields null txHash', async (t) => {
  const client = new X402Client(keypair.secret(), 'testnet')
  t.mock.method(x402HTTPClient.prototype, 'createPaymentPayload', async () => makePayload())
  const originalFetch = globalThis.fetch

  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const headers = headerRecord(new Headers(init?.headers))
    if (headers['payment-signature']) {
      return settledResponse({ 'X-Payment-Response': 'not base64!!' })
    }
    return paymentRequiredResponse()
  }) as typeof fetch

  try {
    const result = await client.pay('https://api.test/paid', manifest)
    assert.equal(result.txHash, null)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('X402Client - paid 200 with a real transaction hash passes through', async (t) => {
  const client = new X402Client(keypair.secret(), 'testnet')
  t.mock.method(x402HTTPClient.prototype, 'createPaymentPayload', async () => makePayload())
  const originalFetch = globalThis.fetch

  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const headers = headerRecord(new Headers(init?.headers))
    if (headers['payment-signature']) {
      return settledResponse({
        'X-Payment-Response': encodePaymentResponseHeader({
          success: true,
          transaction: 'abc123hash',
          network: 'stellar:testnet',
        }),
      })
    }
    return paymentRequiredResponse()
  }) as typeof fetch

  try {
    const result = await client.pay('https://api.test/paid', manifest)
    assert.equal(result.txHash, 'abc123hash')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('X402Client - debug diagnostics trace probe, paid response, and header state', async (t) => {
  const lines: Array<{
    level: RouteDockLogLevel
    message: string
    fields: RouteDockLogFields | undefined
  }> = []
  const client = new X402Client(
    keypair.secret(),
    'testnet',
    undefined,
    undefined,
    (level, message, fields) => lines.push({ level, message, fields }),
  )
  t.mock.method(x402HTTPClient.prototype, 'createPaymentPayload', async () => makePayload())
  const originalFetch = globalThis.fetch

  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    const headers = headerRecord(new Headers(init?.headers))
    if (headers['payment-signature']) return settledResponse({})
    return paymentRequiredResponse()
  }) as typeof fetch

  try {
    const result = await client.pay('https://api.test/paid', manifest)
    assert.equal(result.txHash, null)

    const messages = lines.map((l) => l.message)
    assert.ok(messages.includes('[x402] unpaid probe response'), 'probe status logged')
    assert.ok(
      messages.includes('[x402] sending paid request with payment header'),
      'paid request logged',
    )
    assert.ok(messages.includes('[x402] paid request response'), 'paid response logged')
    assert.ok(
      messages.includes('[x402] settled 2xx carried no X-Payment-Response header'),
      'missing response header logged',
    )
    const probe = lines.find((l) => l.message === '[x402] unpaid probe response')
    assert.equal(probe?.fields?.status, 402)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('X402Client - free non-402 probe is logged as a free response', async () => {
  const lines: string[] = []
  const client = new X402Client(
    keypair.secret(),
    'testnet',
    undefined,
    undefined,
    (_level, message) => lines.push(message),
  )
  const originalFetch = globalThis.fetch

  globalThis.fetch = (async () => jsonResponse({ status: 'ok', free: true })) as typeof fetch

  try {
    const result = await client.pay('https://api.test/paid-but-open', manifest)
    assert.equal(result.txHash, null)
    assert.equal(result.amount, '0')
    assert.ok(
      lines.includes('[x402] unpaid probe returned non-402 success — serving as free response'),
      'free path is visible in the debug trail',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
