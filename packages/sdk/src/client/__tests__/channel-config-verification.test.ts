/**
 * RouteDock #164 — the refund waiting period must be verified against the
 * deployed channel contract, not merely trusted from the provider's manifest.
 *
 * The manifest is published by the provider and is not authoritative for what
 * is actually deployed, so a session may only open when the contract's own
 * configuration agrees with the claim. These tests cover the bounds on the
 * declared value, the agreement check, and the two ways the read itself can
 * fail — an unreadable window is never treated as agreement.
 *
 * Run with: pnpm --filter @routedock/routedock test
 * (requires --experimental-test-module-mocks, set in the package test script)
 */

import assert from 'node:assert/strict'
import { beforeEach, describe, it, mock } from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import type { RouteDockManifest } from '../../types.js'
import {
  RouteDockChannelStateError,
  RouteDockManifestError,
} from '../../errors.js'

const SESSION_URL = 'https://provider.test/stream/orderbook'
const CHANNEL_CONTRACT = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'
const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'

/** The declared/on-chain value every fixture starts from: 24 h at 5 s/ledger. */
const DECLARED = 17_280
/** The documented ceiling: 30 days at 5 s/ledger. */
const MAX_PERIOD = 518_400

// ── Scripted channel state ────────────────────────────────────────────────────
// MppSessionClient reads the contract through a call-time dynamic import, so a
// module mock registered here is picked up by openSession. `reads` proves that
// the cheap bounds rejection happens before any round-trip.

let reads = 0
let script: () => Promise<unknown> = async () => ({ refundWaitingPeriod: DECLARED })

mock.module('@stellar/mpp/channel/server', {
  namedExports: {
    getChannelState: async () => {
      reads++
      return script()
    },
  },
})

mock.module('@stellar/mpp/channel/client', {
  namedExports: {
    stellar: { channel: () => ({}) },
  },
})

mock.module('mppx/client', {
  namedExports: {
    Mppx: {
      create: () => ({
        fetch: async () =>
          new Response(JSON.stringify({ seq: 1 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      }),
    },
  },
})

const {
  MppSessionClient,
  assertRefundWaitingPeriodAgrees,
  assertRefundWaitingPeriodInBounds,
} = await import('../MppSessionClient.js')

function buildManifest(overrides: { refundWaitingPeriod?: number } = {}): RouteDockManifest {
  return {
    routedock: '1.0',
    name: 'Channel Config Test Provider',
    description: 'Provider exercised by channel config verification tests',
    modes: ['mpp-session'],
    network: 'testnet',
    asset: 'USDC',
    asset_contract: ASSET_CONTRACT,
    payee: Keypair.random().publicKey(),
    pricing: {
      'mpp-session': {
        rate: '0.0001',
        per: 'voucher',
        channel_factory: CHANNEL_CONTRACT,
        min_deposit: '0.10',
        refund_waiting_period_ledgers: overrides.refundWaitingPeriod ?? DECLARED,
      },
    },
    endpoints: { stream: { method: 'GET', path: '/stream/orderbook' } },
    tags: ['orderbook', 'test'],
  }
}

function openSession(manifest: RouteDockManifest = buildManifest()) {
  const client = new MppSessionClient(Keypair.random(), 'testnet')
  return client.openSession(
    SESSION_URL,
    manifest,
    Keypair.random().secret(),
    // Disable the lifetime guard: these cases assert on the open path only, and
    // a live timer would outlive the test.
    { maxDurationMs: 0 },
  )
}

beforeEach(() => {
  reads = 0
  script = async () => ({ refundWaitingPeriod: DECLARED })
})

// ── Bounds on the declared value ──────────────────────────────────────────────

describe('assertRefundWaitingPeriodInBounds()', () => {
  it('accepts the documented endpoints of the range', () => {
    assert.doesNotThrow(() => assertRefundWaitingPeriodInBounds(DECLARED))
    assert.doesNotThrow(() => assertRefundWaitingPeriodInBounds(MAX_PERIOD))
  })

  it('rejects a window shorter than the floor', () => {
    assert.throws(
      () => assertRefundWaitingPeriodInBounds(DECLARED - 1),
      (err: unknown) =>
        err instanceof RouteDockManifestError &&
        /< minimum 17280/.test((err as Error).message),
    )
  })

  it('rejects a window that would lock funds past the ceiling', () => {
    assert.throws(
      () => assertRefundWaitingPeriodInBounds(MAX_PERIOD + 1),
      (err: unknown) =>
        err instanceof RouteDockManifestError &&
        /> maximum 518400/.test((err as Error).message),
    )
  })
})

describe('assertRefundWaitingPeriodAgrees()', () => {
  it('accepts an exact match', () => {
    assert.doesNotThrow(() =>
      assertRefundWaitingPeriodAgrees(DECLARED, DECLARED, {
        mode: 'mpp-session',
        channel: CHANNEL_CONTRACT,
      }),
    )
  })

  it('rejects a disagreement and names both values and the contract', () => {
    assert.throws(
      () =>
        assertRefundWaitingPeriodAgrees(DECLARED, DECLARED * 2, {
          mode: 'mpp-session',
          channel: CHANNEL_CONTRACT,
        }),
      (err: unknown) => {
        if (!(err instanceof RouteDockManifestError)) return false
        const message = (err as Error).message
        return (
          message.includes(String(DECLARED)) &&
          message.includes(String(DECLARED * 2)) &&
          message.includes(CHANNEL_CONTRACT)
        )
      },
    )
  })
})

// ── openSession() ─────────────────────────────────────────────────────────────

describe('openSession() channel config verification', () => {
  it('opens when the deployed contract agrees with the manifest', async () => {
    const handle = await openSession()
    assert.equal(handle.channelId, CHANNEL_CONTRACT)
    assert.equal(reads, 1)
  })

  it('refuses a contract whose window is longer than declared', async () => {
    // The bug from #164: the manifest promises 24 h, the contract allows far
    // longer, so the agent's funds stay locked beyond the window it agreed to.
    script = async () => ({ refundWaitingPeriod: DECLARED * 10 })

    await assert.rejects(
      () => openSession(),
      (err: unknown) =>
        err instanceof RouteDockManifestError &&
        (err as Error).message.includes(String(DECLARED * 10)),
    )
  })

  it('refuses a contract whose window is shorter than declared', async () => {
    script = async () => ({ refundWaitingPeriod: DECLARED * 2 })

    await assert.rejects(
      () => openSession(),
      (err: unknown) => err instanceof RouteDockManifestError,
    )
  })

  it('refuses an over-long declared window without reading the chain', async () => {
    await assert.rejects(
      () => openSession(buildManifest({ refundWaitingPeriod: MAX_PERIOD + 1 })),
      (err: unknown) => err instanceof RouteDockManifestError,
    )
    // A manifest that cannot be sane is rejected on its own terms — the
    // round-trip is not spent on it.
    assert.equal(reads, 0)
  })

  it('refuses a below-floor declared window without reading the chain', async () => {
    await assert.rejects(
      () => openSession(buildManifest({ refundWaitingPeriod: DECLARED - 1 })),
      (err: unknown) => err instanceof RouteDockManifestError,
    )
    assert.equal(reads, 0)
  })

  it('refuses to open when the contract state cannot be read', async () => {
    // Fail closed: an unverifiable window is not a verified one, so an RPC
    // outage must not silently downgrade to trusting the manifest.
    script = async () => {
      throw new Error('rpc unavailable')
    }

    await assert.rejects(
      () => openSession(),
      (err: unknown) =>
        err instanceof RouteDockChannelStateError &&
        /Failed to read channel config/.test((err as Error).message),
    )
  })

  it('refuses to open when the contract reports no waiting period', async () => {
    script = async () => ({})

    await assert.rejects(
      () => openSession(),
      (err: unknown) =>
        err instanceof RouteDockChannelStateError &&
        /did not report a refund waiting period/.test((err as Error).message),
    )
  })

  it('refuses to open when the contract reports a non-numeric window', async () => {
    script = async () => ({ refundWaitingPeriod: '17280' })

    await assert.rejects(
      () => openSession(),
      (err: unknown) => err instanceof RouteDockChannelStateError,
    )
  })
})
