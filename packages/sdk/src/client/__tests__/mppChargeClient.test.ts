/**
 * Unit tests for MppChargeClient — the client half of charge mode.
 *
 * Mirrors the pattern used in session-ws.test.ts: mock mppx/client and
 * @stellar/mpp/charge/client before importing the SUT so the fee/charge
 * flow can be exercised without touching the network.
 */
import { mock, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@stellar/stellar-sdk'
import type { RouteDockManifest } from '../../types.js'
import { RouteDockManifestError } from '../../errors.js'

// ── Scripted mppx layer ──────────────────────────────────────────────────────

interface MppxScript {
  /** HTTP status returned by mppx.fetch */
  fetchStatus?: number
  /** If true, mppx.fetch rejects with a network error */
  fetchRejects?: boolean
  /** If true, mppx.fetch returns a 200 non-JSON response */
  fetchNonJson?: boolean
  /** If set, onProgress fires with this hash (simulating settlement) */
  paidHash?: string
  /** If true, onProgress fires with a paid event */
  firePaid?: boolean
}

let mppxScript: MppxScript = {}

let capturedOnProgress: ((event: { type: string; hash?: string }) => void) | undefined

const fakeMppx = {
  fetch: async (): Promise<Response> => {
    if (mppxScript.fetchRejects) {
      throw new TypeError('fetch failed')
    }
    if (mppxScript.fetchNonJson) {
      return new Response('<html>proxy error</html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      })
    }
    const status = mppxScript.fetchStatus ?? 200
    if (status === 200) {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }
    return new Response(JSON.stringify({ error: 'fail' }), { status })
  },
}

mock.module('mppx/client', {
  namedExports: {
    Mppx: {
      create: (opts: { methods: Array<{ name: string; onProgress?: (e: unknown) => void }> }) => {
        // Capture onProgress from the stellar.charge method
        for (const m of opts.methods) {
          if (m.onProgress) {
            capturedOnProgress = m.onProgress as (e: { type: string; hash?: string }) => void
          }
        }
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
    const client = new MppChargeClient(Keypair.random(), 'testnet')
    await assert.rejects(
      () => client.pay('https://provider.test/price', buildManifest()),
      (err: unknown) => err instanceof Error && /MPP charge request/i.test(err.message),
    )
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
