import assert from 'node:assert/strict'
import test from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import { encodePaymentRequiredHeader } from '@x402/core/http'
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
  const client = new X402Client(keypair.secret(), 'testnet', { baseDelayMs: 1, maxDelayMs: 5 })
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
      (err: unknown) => {
        assert.ok(err instanceof RouteDockFacilitatorError)
        assert.equal((err as RouteDockFacilitatorError).status, 500)
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

// ── #386 — a payment must be signed at most once per pay() ─────────────────────
//
// X402Client.pay() used to wrap the whole flow (probe + sign + paid request) in
// withRetry, so a 5xx/429/network error on the paid request re-ran the closure
// and signed a fresh payment. With the default maxAttempts of 4, one pay() could
// settle up to four independent on-chain payments. The fix signs once and every
// retry resends the same header.

// A real X-Payment-Requirements header the probe's decode step will accept.
const REQ_HEADER = encodePaymentRequiredHeader({
  x402Version: 2,
  resource: { url: 'https://api.test/price', description: 'test' },
  accepts: [
    {
      scheme: 'exact' as const,
      network: 'stellar:testnet' as const,
      asset: manifest.asset_contract,
      amount: '100000',
      payTo: keypair.publicKey(),
      maxTimeoutSeconds: 60,
      extra: { areFeesSponsored: true, facilitatorAddresses: [keypair.publicKey()] },
    },
  ],
} as Parameters<typeof encodePaymentRequiredHeader>[0])

interface FetchScript {
  /** Statuses for successive unpaid-probe calls (last repeats). 402 ⇒ serve REQ_HEADER. */
  probe: number[]
  /** Statuses for successive paid calls (last repeats). 'reject' ⇒ throw a network error. */
  paid: Array<number | 'reject'>
}

/** A fetch stub that distinguishes the unpaid probe from paid requests by the payment header. */
function scriptedFetch(script: FetchScript): {
  fn: typeof fetch
  paidHeaders: Array<Record<string, string>>
} {
  const paidHeaders: Array<Record<string, string>> = []
  let probeIdx = 0
  let paidIdx = 0
  const fn = (async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    const hasPayment = Object.keys(headers).some((k) => k.toLowerCase() === 'x-payment')

    if (!hasPayment) {
      const s = script.probe[Math.min(probeIdx, script.probe.length - 1)]!
      probeIdx++
      if (s === 402) {
        return new Response(JSON.stringify({ error: 'Payment Required' }), {
          status: 402,
          headers: { 'X-Payment-Requirements': REQ_HEADER },
        })
      }
      return new Response('probe', { status: s })
    }

    paidHeaders.push({ ...headers })
    const s = script.paid[Math.min(paidIdx, script.paid.length - 1)]!
    paidIdx++
    if (s === 'reject') throw new TypeError('fetch failed')
    if (s === 200) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ error: 'fail' }), { status: s })
  }) as typeof fetch
  return { fn, paidHeaders }
}

/** Replace the instance's signing so createPaymentPayload calls can be counted. */
function stubSigning(client: X402Client): { getSignCount: () => number } {
  let signCount = 0
  const hc = (
    client as unknown as {
      httpClient: {
        createPaymentPayload: (req: unknown) => Promise<unknown>
        encodePaymentSignatureHeader: (payload: unknown) => Record<string, string>
      }
    }
  ).httpClient
  hc.createPaymentPayload = async () => {
    signCount++
    return { sig: signCount }
  }
  hc.encodePaymentSignatureHeader = (payload: unknown) => ({
    'x-payment': `sig-${(payload as { sig: number }).sig}`,
  })
  return { getSignCount: () => signCount }
}

test('#386 — x402 signs once and resends the same header on retry (paid always 500)', async () => {
  const client = new X402Client(keypair.secret(), 'testnet', { baseDelayMs: 1, maxDelayMs: 5 })
  const { getSignCount } = stubSigning(client)
  const { fn, paidHeaders } = scriptedFetch({ probe: [402], paid: [500] })
  const originalFetch = globalThis.fetch
  globalThis.fetch = fn
  try {
    await assert.rejects(
      () => client.pay('https://api.test/price', manifest),
      (err: unknown) => {
        assert.ok(err instanceof RouteDockFacilitatorError, `expected facilitator error, got ${String(err)}`)
        assert.equal((err as RouteDockFacilitatorError).status, 500)
        return true
      },
    )
    assert.equal(getSignCount(), 1, 'payment signed exactly once')
    assert.equal(paidHeaders.length, 4, 'default maxAttempts sends 4 paid requests')
    const first = JSON.stringify(paidHeaders[0])
    assert.ok(
      paidHeaders.every((h) => JSON.stringify(h) === first),
      'every paid request carries the identical payment header',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('#386 — x402 retries the paid request after a network error, signing only once', async () => {
  const client = new X402Client(keypair.secret(), 'testnet', { baseDelayMs: 1, maxDelayMs: 5 })
  const { getSignCount } = stubSigning(client)
  const { fn, paidHeaders } = scriptedFetch({ probe: [402], paid: ['reject', 200] })
  const originalFetch = globalThis.fetch
  globalThis.fetch = fn
  try {
    const result = await client.pay('https://api.test/price', manifest)
    assert.deepEqual(result.data, { ok: true })
    assert.equal(getSignCount(), 1)
    assert.equal(paidHeaders.length, 2, 'one failed + one successful paid request')
    assert.equal(
      JSON.stringify(paidHeaders[0]),
      JSON.stringify(paidHeaders[1]),
      'both paid requests carry the identical header',
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('#386 — x402 retries the unpaid probe, then signs once', async () => {
  const client = new X402Client(keypair.secret(), 'testnet', { baseDelayMs: 1, maxDelayMs: 5 })
  const { getSignCount } = stubSigning(client)
  const { fn, paidHeaders } = scriptedFetch({ probe: [503, 402], paid: [200] })
  const originalFetch = globalThis.fetch
  globalThis.fetch = fn
  try {
    const result = await client.pay('https://api.test/price', manifest)
    assert.deepEqual(result.data, { ok: true })
    assert.equal(getSignCount(), 1, 'probe retry does not cause an extra signature')
    assert.equal(paidHeaders.length, 1)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('#386 — x402 does not re-sign when a paid retry returns 402', async () => {
  const client = new X402Client(keypair.secret(), 'testnet', { baseDelayMs: 1, maxDelayMs: 5 })
  const { getSignCount } = stubSigning(client)
  const { fn, paidHeaders } = scriptedFetch({ probe: [402], paid: [402] })
  const originalFetch = globalThis.fetch
  globalThis.fetch = fn
  try {
    await assert.rejects(
      () => client.pay('https://api.test/price', manifest),
      (err: unknown) => {
        assert.ok(err instanceof RouteDockManifestError, `expected manifest error, got ${String(err)}`)
        return true
      },
    )
    assert.equal(getSignCount(), 1, 'exactly one signature even though the paid request 402s')
    assert.equal(paidHeaders.length, 1, 'a 402 on the paid request is not retried')
  } finally {
    globalThis.fetch = originalFetch
  }
})
