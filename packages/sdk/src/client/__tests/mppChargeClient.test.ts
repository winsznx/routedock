/**
 * Unit tests for MppChargeClient — the client half of charge mode.
 *
 * Mocks mppx/client and @stellar/mpp/charge/client before importing the SUT so
 * the fee/charge flow can be exercised without touching the network. The mppx
 * mock captures onChallenge and exposes a rawFetch so #386's "sign once, resend
 * the credential on retry" behaviour can be asserted.
 */
import { mock, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@stellar/stellar-sdk'
import type { RouteDockManifest } from '../../types.js'

// ── Scripted mppx layer ──────────────────────────────────────────────────────

interface MppxScript {
  /** Single status returned by every mppx.fetch / rawFetch call. */
  fetchStatus?: number
  /** Per-call status queue (consumed by fetch then rawFetch, in order). Overrides fetchStatus. */
  statuses?: number[]
  /** If true, mppx.fetch rejects with a network error before answering the challenge. */
  fetchRejects?: boolean
  /** Unused legacy fields kept for older test call sites. */
  paidHash?: string
  firePaid?: boolean
}

let mppxScript: MppxScript = {}
let capturedOnProgress: ((event: { type: string; hash?: string }) => void) | undefined
let capturedOnChallenge:
  | ((challenge: unknown, helpers: { createCredential: () => Promise<string> }) => Promise<string>)
  | undefined
let mppxCreateCalls = 0
let createCredentialCalls = 0
let rawFetchAuths: Array<string | undefined> = []

const CREDENTIAL = 'CRED_TEST_ABC'

function nextStatus(): number {
  if (mppxScript.statuses && mppxScript.statuses.length > 0) {
    return mppxScript.statuses.shift() as number
  }
  return mppxScript.fetchStatus ?? 200
}

function statusResponse(status: number): Response {
  if (status === 200) {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  return new Response(JSON.stringify({ error: 'fail' }), { status })
}

const fakeMppx = {
  fetch: async (): Promise<Response> => {
    if (mppxScript.fetchRejects) {
      throw new TypeError('fetch failed')
    }
    // Simulate receiving a 402 challenge: the client's onChallenge signs once.
    if (capturedOnChallenge) {
      await capturedOnChallenge(
        {},
        {
          createCredential: async () => {
            createCredentialCalls++
            return CREDENTIAL
          },
        },
      )
    }
    return statusResponse(nextStatus())
  },
  rawFetch: async (
    _url: string | URL,
    init?: { headers?: Record<string, string> },
  ): Promise<Response> => {
    rawFetchAuths.push(init?.headers?.['Authorization'])
    return statusResponse(nextStatus())
  },
}

mock.module('mppx/client', {
  namedExports: {
    Mppx: {
      create: (opts: {
        methods: Array<{ name: string; onProgress?: (e: unknown) => void }>
        onChallenge?: (
          challenge: unknown,
          helpers: { createCredential: () => Promise<string> },
        ) => Promise<string>
      }) => {
        mppxCreateCalls++
        // Capture onProgress from the stellar.charge method
        for (const m of opts.methods) {
          if (m.onProgress) {
            capturedOnProgress = m.onProgress as (e: { type: string; hash?: string }) => void
          }
        }
        capturedOnChallenge = opts.onChallenge
        return fakeMppx
      },
    },
  },
})

mock.module('@stellar/mpp/charge/client', {
  namedExports: {
    stellar: {
      charge: (opts: { onProgress?: (e: { type: string; hash?: string }) => void }) => ({
        name: 'stellar/charge',
        intent: 'charge',
        onProgress: opts.onProgress,
      }),
    },
  },
})

const { MppChargeClient } = await import('../MppChargeClient.js')

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const PAYEE = Keypair.random()

function buildManifest(): RouteDockManifest {
  return {
    routedock: '1.0',
    name: 'Charge Test Provider',
    description: 'MppChargeClient unit test',
    modes: ['mpp-charge'],
    network: 'testnet',
    asset: 'USDC',
    asset_contract: ASSET_CONTRACT,
    payee: PAYEE.publicKey(),
    pricing: {
      'mpp-charge': { amount: '0.0008', per: 'request' },
    },
    endpoints: { price: { method: 'GET', path: '/price' } },
    tags: ['test'],
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MppChargeClient — success path', () => {
  it('returns a PaymentResult with mode "mpp-charge" on HTTP 200', async () => {
    mppxScript = { fetchStatus: 200 }
    const client = new MppChargeClient(Keypair.random(), 'testnet')
    const result = await client.pay('https://provider.test/price', buildManifest())
    assert.equal(result.mode, 'mpp-charge')
    assert.equal(result.amount, '0.0008')
    assert.deepEqual(result.data, { ok: true })
    assert.equal(result.txHash, null, 'no paid event means txHash stays null')
    assert.equal(typeof result.timestamp, 'number')
  })

  it('captures txHash when onProgress fires with a paid event', async () => {
    mppxScript = { fetchStatus: 200, firePaid: true }
    const client = new MppChargeClient(Keypair.random(), 'testnet')

    // Fire the paid event before pay() is called — capturedOnProgress is set
    // when Mppx.create() runs inside pay(), so we use a microtask to fire it
    // after the client sets it up.
    const originalCreate = fakeMppx.fetch
    fakeMppx.fetch = async () => {
      capturedOnProgress?.({ type: 'paid', hash: 'TX_HASH_ABC123' })
      const resp = await originalCreate()
      return resp
    }
    try {
      const result = await client.pay('https://provider.test/price', buildManifest())
      assert.equal(result.txHash, 'TX_HASH_ABC123')
    } finally {
      fakeMppx.fetch = originalCreate
    }
  })
})

describe('MppChargeClient — manifest validation', () => {
  it('throws RouteDockManifestError when mpp-charge pricing is missing', async () => {
    const manifest = buildManifest()
    delete manifest.pricing['mpp-charge']
    const client = new MppChargeClient(Keypair.random(), 'testnet')
    await assert.rejects(
      () => client.pay('https://provider.test/price', manifest),
      (err: unknown) =>
        err instanceof Error && /manifest\.pricing\.mpp-charge missing/.test(err.message),
    )
  })
})

describe('MppChargeClient — network errors', () => {
  it('wraps fetch rejection as RouteDockNetworkError', async () => {
    mppxScript = { fetchRejects: true }
    const client = new MppChargeClient(Keypair.random(), 'testnet', { baseDelayMs: 1, maxDelayMs: 5 })
    await assert.rejects(
      () => client.pay('https://provider.test/price', buildManifest()),
      (err: unknown) => err instanceof Error && /MPP charge request/i.test(err.message),
    )
  })
})

describe('MppChargeClient — HTTP errors', () => {
  it('throws RouteDockFacilitatorError for 5xx status', async () => {
    mppxScript = { fetchStatus: 500 }
    const client = new MppChargeClient(Keypair.random(), 'testnet', { baseDelayMs: 1, maxDelayMs: 5 })
    await assert.rejects(
      () => client.pay('https://provider.test/price', buildManifest()),
      (err: unknown) => {
        const e = err as { status?: number }
        return e.status === 500
      },
    )
  })

  it('throws RouteDockFacilitatorError for 429 status', async () => {
    mppxScript = { fetchStatus: 429 }
    const client = new MppChargeClient(Keypair.random(), 'testnet', { baseDelayMs: 1, maxDelayMs: 5 })
    await assert.rejects(
      () => client.pay('https://provider.test/price', buildManifest()),
      (err: unknown) => {
        const e = err as { status?: number }
        return e.status === 429
      },
    )
  })

  it('throws RouteDockManifestError for 4xx status (non-retryable)', async () => {
    mppxScript = { fetchStatus: 400 }
    const client = new MppChargeClient(Keypair.random(), 'testnet')
    await assert.rejects(
      () => client.pay('https://provider.test/price', buildManifest()),
      (err: unknown) =>
        err instanceof Error && /MPP charge failed: HTTP 400/.test(err.message),
    )
  })
})

describe('MppChargeClient — retry policy', () => {
  it('retries on retryable error with a retry policy', async () => {
    let attempts = 0
    mppxScript = {}
    const originalFetch = fakeMppx.fetch
    fakeMppx.fetch = async () => {
      attempts++
      if (attempts < 3) {
        throw new TypeError('transient failure')
      }
      return originalFetch()
    }
    try {
      const client = new MppChargeClient(Keypair.random(), 'testnet', {
        maxAttempts: 3,
        baseDelayMs: 1,
        maxDelayMs: 5,
      })
      const result = await client.pay('https://provider.test/price', buildManifest())
      assert.equal(result.mode, 'mpp-charge')
      assert.ok(attempts >= 3, `expected at least 3 attempts, got ${attempts}`)
    } finally {
      fakeMppx.fetch = originalFetch
    }
  })
})

describe('#386 — sign once, resend the credential on retry', () => {
  it('signs the credential once and resends it via rawFetch when the paid request keeps failing', async () => {
    mppxScript = { fetchStatus: 500 }
    mppxCreateCalls = 0
    createCredentialCalls = 0
    rawFetchAuths = []
    const client = new MppChargeClient(Keypair.random(), 'testnet', { baseDelayMs: 1, maxDelayMs: 5 })
    await assert.rejects(
      () => client.pay('https://provider.test/price', buildManifest()),
      (err: unknown) => (err as { status?: number }).status === 500,
    )
    assert.equal(mppxCreateCalls, 1, 'Mppx.create is called once per pay()')
    assert.equal(createCredentialCalls, 1, 'the credential is signed exactly once')
    assert.equal(rawFetchAuths.length, 3, 'the 3 retries after the first attempt use rawFetch')
    assert.ok(
      rawFetchAuths.every((a) => a === CREDENTIAL),
      'every retry resends the same credential',
    )
  })

  it('does not create a second credential when a retried paid request returns 402', async () => {
    mppxScript = { statuses: [500, 402] }
    mppxCreateCalls = 0
    createCredentialCalls = 0
    rawFetchAuths = []
    const client = new MppChargeClient(Keypair.random(), 'testnet', { baseDelayMs: 1, maxDelayMs: 5 })
    await assert.rejects(
      () => client.pay('https://provider.test/price', buildManifest()),
      (err: unknown) => err instanceof Error && /MPP charge failed: HTTP 402/.test(err.message),
    )
    assert.equal(createCredentialCalls, 1, 'no second credential is created')
    assert.equal(rawFetchAuths.length, 1, 'only the single 402 retry went through rawFetch')
    assert.equal(rawFetchAuths[0], CREDENTIAL)
  })
})
