/**
 * Unit tests for MppChargeClient — the client half of charge mode.
 *
 * Mirrors the pattern used in session-ws.test.ts: mock mppx/client and
 * @stellar/mpp/charge/client before importing the SUT so the fee/charge
 * flow can be exercised without touching the network.
 */
import { mock, describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@stellar/stellar-sdk'
import type { RouteDockManifest } from '../../types.js'
import {
  RouteDockManifestError,
  RouteDockSignatureError,
  RouteDockNetworkError,
  RouteDockFacilitatorError,
  RouteDockPolicyRejectError,
} from '../../errors.js'

// ── Scripted mppx layer ──────────────────────────────────────────────────────

type ChallengeRequest = {
  amount: string
  currency: string
  recipient: string
  methodDetails?: { network?: unknown }
}

interface MppxScript {
  /** HTTP status returned by mppx.fetch */
  fetchStatus?: number
  /** If true, mppx.fetch rejects with a network error */
  fetchRejects?: boolean
  /** If true, mppx.fetch returns a 200 non-JSON response */
  fetchNonJson?: boolean
  /** Custom error thrown by mppx.fetch */
  fetchError?: Error
  /** If set, onProgress fires with this hash (simulating settlement) */
  paidHash?: string
  /** If true, onProgress fires with a paid event */
  firePaid?: boolean
  /** If set, fake mppx.fetch calls onChallenge with this request first */
  challenge?: ChallengeRequest
  /** HTTP status returned by mppx.rawFetch (retried paid requests) */
  rawFetchStatus?: number
}

let mppxScript: MppxScript = {}

let capturedOnProgress: ((event: { type: string; hash?: string }) => void) | undefined
let capturedOnChallenge:
  | ((
      challenge: { request: Record<string, unknown> },
      helpers: { createCredential: () => Promise<string> },
    ) => Promise<string | undefined>)
  | undefined

let createCalls = 0
let createCredentialCalls = 0
const rawFetchAuthHeaders: Array<string | undefined> = []

function resetFakeState(): void {
  mppxScript = {}
  capturedOnProgress = undefined
  capturedOnChallenge = undefined
  createCalls = 0
  createCredentialCalls = 0
  rawFetchAuthHeaders.length = 0
}

function response(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const fakeMppx = {
  fetch: async (): Promise<Response> => {
    if (mppxScript.fetchError) {
      throw mppxScript.fetchError
    }
    if (mppxScript.fetchRejects) {
      throw new TypeError('fetch failed')
    }
    if (mppxScript.fetchNonJson) {
      return new Response('<html>proxy error</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      })
    }
    if (mppxScript.challenge && capturedOnChallenge) {
      // Simulate a 402: mppx parses the challenge, then calls onChallenge.
      await capturedOnChallenge({ request: mppxScript.challenge }, {
        createCredential: async () => {
          createCredentialCalls++
          return 'Payment fake-credential'
        },
      })
    }
    const status = mppxScript.fetchStatus ?? 200
    return status === 200 ? response({ ok: true }, 200) : response({ error: 'fail' }, status)
  },
  rawFetch: async (_url: string, init?: RequestInit): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>
    rawFetchAuthHeaders.push(headers['Authorization'])
    const status = mppxScript.rawFetchStatus ?? mppxScript.fetchStatus ?? 200
    return status === 200 ? response({ ok: true }, 200) : response({ error: 'fail' }, status)
  },
}

mock.module('mppx/client', {
  namedExports: {
    Mppx: {
      create: (opts: {
        methods: Array<{ name: string; onProgress?: (e: unknown) => void }>
        onChallenge?: typeof capturedOnChallenge
      }) => {
        createCalls++
        for (const m of opts.methods) {
          if (m.onProgress) {
            capturedOnProgress = m.onProgress as (e: { type: string; hash?: string }) => void
          }
        }
        if (opts.onChallenge) capturedOnChallenge = opts.onChallenge
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

function matchingChallenge(overrides: Partial<ChallengeRequest> = {}): ChallengeRequest {
  return {
    amount: '8000',
    currency: ASSET_CONTRACT,
    recipient: PAYEE.publicKey(),
    methodDetails: { network: 'stellar:testnet' },
    ...overrides,
  }
}

beforeEach(resetFakeState)

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

    const originalFetch = fakeMppx.fetch
    fakeMppx.fetch = async () => {
      capturedOnProgress?.({ type: 'paid', hash: 'TX_HASH_ABC123' })
      const resp = await originalFetch()
      return resp
    }
    try {
      const result = await client.pay('https://provider.test/price', buildManifest())
      assert.equal(result.txHash, 'TX_HASH_ABC123')
    } finally {
      fakeMppx.fetch = originalFetch
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
    const client = new MppChargeClient(Keypair.random(), 'testnet')
    await assert.rejects(
      () => client.pay('https://provider.test/price', buildManifest()),
      (err: unknown) => {
        assert.ok(err instanceof RouteDockNetworkError)
        assert.equal(err.code, 'NETWORK')
        assert.equal(err.retryable, true)
        assert.ok(/MPP charge request/i.test(err.message))
        return true
      },
    )
  })

  it('wraps plain error as RouteDockSignatureError (retryable === false) and does not retry', async () => {
    let callCount = 0
    const signingError = new Error('bad challenge')
    const originalFetch = fakeMppx.fetch
    fakeMppx.fetch = async () => {
      callCount++
      throw signingError
    }
    try {
      const client = new MppChargeClient(Keypair.random(), 'testnet', {
        maxAttempts: 3,
        baseDelayMs: 1,
        maxDelayMs: 5,
      })
      await assert.rejects(
        () => client.pay('https://provider.test/price', buildManifest()),
        (err: unknown) => {
          assert.ok(err instanceof RouteDockSignatureError)
          assert.equal(err.retryable, false)
          assert.equal(err.code, 'SIGNATURE')
          assert.equal(err.cause, signingError)
          assert.ok(err.message.includes('MPP charge request: Error: bad challenge'))
          return true
        },
      )
      assert.equal(callCount, 1, 'mppx.fetch must be called exactly once (no retries)')
    } finally {
      fakeMppx.fetch = originalFetch
    }
  })
})

describe('MppChargeClient — HTTP errors', () => {
  it('throws RouteDockFacilitatorError for 5xx status', async () => {
    mppxScript = { fetchStatus: 500 }
    const client = new MppChargeClient(Keypair.random(), 'testnet')
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
    const client = new MppChargeClient(Keypair.random(), 'testnet')
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

  it('throws RouteDockManifestError when 200 response body is not JSON', async () => {
    mppxScript = { fetchNonJson: true }
    const client = new MppChargeClient(Keypair.random(), 'testnet')
    await assert.rejects(
      () => client.pay('https://provider.test/price', buildManifest()),
      (err: unknown) => {
        assert.ok(err instanceof RouteDockManifestError)
        assert.match(err.message, /Failed to parse JSON from response \(HTTP 200\)/)
        assert.ok(err.cause instanceof SyntaxError)
        return true
      },
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

// ── #386: create the credential at most once per pay() ───────────────────────

describe('MppChargeClient — signs once per pay()', () => {
  it('always 500: creates one credential and reuses it via rawFetch on every retry', async () => {
    mppxScript = { challenge: matchingChallenge(), fetchStatus: 500, rawFetchStatus: 500 }
    const client = new MppChargeClient(Keypair.random(), 'testnet', {
      baseDelayMs: 1,
      maxDelayMs: 5,
    })
    await assert.rejects(
      () => client.pay('https://provider.test/price', buildManifest()),
      (err: unknown) => {
        const e = err as { status?: number }
        return e.status === 500
      },
    )
    assert.equal(createCalls, 1, 'Mppx.create is called once per pay()')
    assert.equal(createCredentialCalls, 1, 'the credential is created once')
    assert.equal(rawFetchAuthHeaders.length, 3, 'retries 2-4 go through rawFetch')
    for (const auth of rawFetchAuthHeaders) {
      assert.equal(auth, rawFetchAuthHeaders[0])
      assert.ok(auth, 'each rawFetch carries the cached Authorization header')
    }
  })

  it('a retried paid request returning 402 rejects without a second credential', async () => {
    mppxScript = { challenge: matchingChallenge(), fetchStatus: 500, rawFetchStatus: 402 }
    const client = new MppChargeClient(Keypair.random(), 'testnet', {
      baseDelayMs: 1,
      maxDelayMs: 5,
    })
    await assert.rejects(
      () => client.pay('https://provider.test/price', buildManifest()),
      (err: unknown) => err instanceof Error && /MPP charge failed: HTTP 402/.test(err.message),
    )
    assert.equal(createCredentialCalls, 1)
    assert.equal(rawFetchAuthHeaders.length, 1)
  })

  it('reports the amount actually signed, not the manifest price', async () => {
    mppxScript = { challenge: matchingChallenge({ amount: '5000' }), fetchStatus: 200 }
    const client = new MppChargeClient(Keypair.random(), 'testnet')
    const result = await client.pay('https://provider.test/price', buildManifest())
    assert.equal(result.amount, '0.0005')
  })
})

// ── #389: bind the unsigned challenge to the signed manifest ─────────────────

describe('MppChargeClient — challenge validation', () => {
  it('passes onChallenge to Mppx.create and accepts a matching challenge', async () => {
    mppxScript = { challenge: matchingChallenge(), fetchStatus: 200 }
    const client = new MppChargeClient(Keypair.random(), 'testnet')
    const result = await client.pay('https://provider.test/price', buildManifest())
    assert.equal(result.mode, 'mpp-charge')
    assert.equal(createCredentialCalls, 1)
  })

  it('rejects an inflated amount without creating a credential', async () => {
    mppxScript = { challenge: matchingChallenge({ amount: '8000000000' }), fetchStatus: 200 }
    const client = new MppChargeClient(Keypair.random(), 'testnet')
    await assert.rejects(
      () => client.pay('https://provider.test/price', buildManifest()),
      (err: unknown) => {
        assert.ok(err instanceof RouteDockPolicyRejectError)
        assert.equal(err.reason, 'challenge_amount_exceeds_manifest')
        return true
      },
    )
    assert.equal(createCredentialCalls, 0)
  })

  it('rejects a swapped recipient without creating a credential', async () => {
    mppxScript = {
      challenge: matchingChallenge({ recipient: Keypair.random().publicKey() }),
      fetchStatus: 200,
    }
    const client = new MppChargeClient(Keypair.random(), 'testnet')
    await assert.rejects(
      () => client.pay('https://provider.test/price', buildManifest()),
      (err: unknown) => {
        assert.ok(err instanceof RouteDockPolicyRejectError)
        assert.equal(err.reason, 'challenge_payee_mismatch')
        return true
      },
    )
    assert.equal(createCredentialCalls, 0)
  })

  it('rejects a swapped currency without creating a credential', async () => {
    mppxScript = { challenge: matchingChallenge({ currency: PAYEE.publicKey() }), fetchStatus: 200 }
    const client = new MppChargeClient(Keypair.random(), 'testnet')
    await assert.rejects(
      () => client.pay('https://provider.test/price', buildManifest()),
      (err: unknown) => {
        assert.ok(err instanceof RouteDockPolicyRejectError)
        assert.equal(err.reason, 'challenge_asset_mismatch')
        return true
      },
    )
    assert.equal(createCredentialCalls, 0)
  })

  it('rejects a mismatched methodDetails.network without creating a credential', async () => {
    mppxScript = {
      challenge: matchingChallenge({ methodDetails: { network: 'stellar:pubnet' } }),
      fetchStatus: 200,
    }
    const client = new MppChargeClient(Keypair.random(), 'testnet')
    await assert.rejects(
      () => client.pay('https://provider.test/price', buildManifest()),
      (err: unknown) => {
        assert.ok(err instanceof RouteDockPolicyRejectError)
        assert.equal(err.reason, 'challenge_network_mismatch')
        return true
      },
    )
    assert.equal(createCredentialCalls, 0)
  })
})
