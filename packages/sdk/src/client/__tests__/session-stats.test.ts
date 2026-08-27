/**
 * Unit tests for SessionHandle.stats() (#32).
 *
 * stats() must expose live vouchersIssued / currentCumulative / channelId /
 * openTxHash without closing the session, updated synchronously on every
 * stream() yield. The real stellar.channel() client signs vouchers via a
 * Soroban RPC call, so mppx/client and @stellar/mpp/channel/client are mocked
 * (registered before the client module is imported, like session-ws.test.ts)
 * and the channel client's onProgress 'signed' event is scripted — that event
 * is what feeds the closure's currentCumulative in the real flow.
 *
 * Run with: pnpm --filter @routedock/routedock test
 */

import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import type { RouteDockManifest } from '../../types.js'

const CHANNEL_CONTRACT = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'
const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const SESSION_URL = 'https://provider.test/stream/orderbook'

// ── Scripted mppx + channel client ───────────────────────────────────────────

type ProgressEvent = { type: 'signed'; cumulativeAmount: string }

let capturedOnProgress: ((event: ProgressEvent) => void) | null = null
// Consumed one per fetch, mirroring one signed voucher per stream() iteration.
let scriptedCumulatives: string[] = []
let scriptedFetchRejects = false

mock.module('@stellar/mpp/channel/client', {
  namedExports: {
    stellar: {
      channel: (opts: { onProgress?: (event: ProgressEvent) => void }) => {
        capturedOnProgress = opts.onProgress ?? null
        return {}
      },
    },
  },
})

mock.module('mppx/client', {
  namedExports: {
    Mppx: {
      create: () => ({
        fetch: async (): Promise<Response> => {
          if (scriptedFetchRejects) {
            throw new TypeError('fetch failed')
          }
          // The real channel client fires onProgress({ type: 'signed' }) when
          // it signs a voucher; the closure reads it into currentCumulative.
          const cumulative = scriptedCumulatives.shift()
          if (cumulative !== undefined) {
            capturedOnProgress?.({ type: 'signed', cumulativeAmount: cumulative })
          }
          return new Response(JSON.stringify({ seq: 1 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        },
      }),
    },
  },
})

const { MppSessionClient } = await import('../MppSessionClient.js')

// ── Fixtures ──────────────────────────────────────────────────────────────────

function buildManifest(): RouteDockManifest {
  return {
    routedock: '1.0',
    name: 'Stats Test Provider',
    description: 'Provider exercised by session stats unit tests',
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
        refund_waiting_period_ledgers: 17280,
      },
    },
    endpoints: { stream: { method: 'GET', path: '/stream/orderbook' } },
    tags: ['orderbook', 'stellar', 'test'],
  }
}

async function openHandle() {
  const client = new MppSessionClient(Keypair.random(), 'testnet')
  return client.openSession(SESSION_URL, buildManifest(), Keypair.random().secret())
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SessionHandle.stats()', () => {
  it('reports zeroed stats and channel identity before any streaming', async () => {
    scriptedCumulatives = []
    scriptedFetchRejects = false
    const handle = await openHandle()

    const stats = handle.stats()
    assert.equal(stats.vouchersIssued, 0)
    assert.equal(stats.currentCumulative, '0.0000000')
    assert.equal(stats.channelId, CHANNEL_CONTRACT)
    assert.equal(stats.openTxHash, null)
  })

  it('reflects vouchers issued and cumulative synchronously after each yield', async () => {
    scriptedCumulatives = ['1000', '2500']
    scriptedFetchRejects = false
    const handle = await openHandle()

    const iter = handle.stream()[Symbol.asyncIterator]()

    await iter.next()
    assert.equal(handle.stats().vouchersIssued, 1)
    assert.equal(handle.stats().currentCumulative, '0.0001000')
    assert.equal(handle.stats().channelId, CHANNEL_CONTRACT)
    assert.equal(handle.stats().openTxHash, null)

    await iter.next()
    assert.equal(handle.stats().vouchersIssued, 2)
    assert.equal(handle.stats().currentCumulative, '0.0002500')
  })

  it('tracks cumulative in payment-asset decimal units matching totalPaid', async () => {
    scriptedCumulatives = ['1000000000'] // 100 USDC in microUSDC
    scriptedFetchRejects = false
    const handle = await openHandle()

    await handle.stream()[Symbol.asyncIterator]().next()
    assert.equal(handle.stats().currentCumulative, '100.0000000')
  })

  it('is stable between yields (same snapshot until the next voucher)', async () => {
    scriptedCumulatives = ['1000', '2000']
    scriptedFetchRejects = false
    const handle = await openHandle()

    const before = handle.stats()
    assert.deepEqual(before, handle.stats())
    assert.equal(handle.stats().vouchersIssued, 0)

    await handle.stream()[Symbol.asyncIterator]().next()
    assert.equal(handle.stats().vouchersIssued, 1)
    assert.deepEqual(handle.stats(), handle.stats())
  })

  it('keeps prior counters intact when a stream iteration fails', async () => {
    scriptedCumulatives = ['1000', '2000']
    scriptedFetchRejects = false
    const handle = await openHandle()

    const iter = handle.stream()[Symbol.asyncIterator]()
    await iter.next()
    assert.equal(handle.stats().vouchersIssued, 1)
    assert.equal(handle.stats().currentCumulative, '0.0001000')

    // Next fetch fails — the iteration throws and must not corrupt stats.
    scriptedFetchRejects = true
    await assert.rejects(() => iter.next())
    assert.equal(handle.stats().vouchersIssued, 1)
    assert.equal(handle.stats().currentCumulative, '0.0001000')
  })

  it('accumulates across many yields', async () => {
    // stats() feeds the same closure counters close() settles on, so a
    // mid-stream per-session sub-cap check agrees with the final settlement.
    scriptedCumulatives = ['1000', '2000', '3000']
    scriptedFetchRejects = false
    const handle = await openHandle()

    const iter = handle.stream()[Symbol.asyncIterator]()
    for (let i = 0; i < 3; i++) {
      await iter.next()
    }
    const stats = handle.stats()
    assert.equal(stats.vouchersIssued, 3)
    assert.equal(stats.currentCumulative, '0.0003000')
  })
})
