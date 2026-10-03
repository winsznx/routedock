/**
 * Unit tests for MppSessionClient.stream() honoring close() (#398).
 *
 * A closed session — whether close() was called by the consumer or by the
 * maxDurationMs lifetime guard — must not issue another voucher. The stream
 * loop is the only place that calls checkSpend() / mppx.fetch(), so these
 * tests count both and assert the counts freeze after close().
 *
 * mppx/client is mocked before the SDK is imported (like session-stats.test.ts)
 * and the Soroban RPC surface used by close() is mocked afterwards (like
 * dispute.test.ts) so the real close() sets its closed flag without touching
 * the network. The only unstubbed call is close()'s DELETE request, served by a
 * global fetch stub.
 *
 * Run with: pnpm --filter @routedock/routedock test
 */

import assert from 'node:assert/strict'
import { after, beforeEach, before, describe, test, mock } from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import type { RouteDockManifest, SessionOptions } from '../../types.js'

const CHANNEL_CONTRACT = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'
const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const SESSION_URL = 'https://provider.test/stream/orderbook'

// ── Executed mppx fetch counter ───────────────────────────────────────────────

/** Incremented once per mppx.fetch() — i.e. once per signed voucher. */
let fetchCallCount = 0

mock.module('@stellar/mpp/channel/client', {
  namedExports: {
    stellar: { channel: () => ({}) },
  },
})

mock.module('mppx/client', {
  namedExports: {
    Mppx: {
      create: () => ({
        fetch: async (): Promise<Response> => {
          fetchCallCount++
          return new Response(JSON.stringify({ seq: fetchCallCount }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        },
      }),
    },
  },
})

const { MppSessionClient } = await import('../MppSessionClient.js')
const { RouteDockChannelStateError } = await import('../../errors.js')

// ── Fake Soroban RPC for close() ──────────────────────────────────────────────

const agentKeypair = Keypair.random()
const commitmentKeypair = Keypair.random()

const DEFAULT_ACCOUNT = {
  accountId: () => agentKeypair.publicKey(),
  sequenceNumber: () => '1',
  incrementSequenceNumber: () => undefined,
}

function buildFakeSdk() {
  class FakeServer {
    constructor(_url: string) {}
    async getAccount() {
      return DEFAULT_ACCOUNT
    }
    async simulateTransaction() {
      return { result: { retval: { bytes: () => Buffer.from([1, 2, 3, 4]) } } }
    }
    async prepareTransaction(tx: unknown) {
      return tx
    }
    async sendTransaction() {
      return { hash: 'STUB_TX_HASH' }
    }
  }

  class FakeContract {
    constructor(_address: string) {}
    call(fn: string, ...args: unknown[]) {
      return { __op: fn, args }
    }
  }

  class FakeTransactionBuilder {
    constructor(_account: unknown, _opts: unknown) {}
    addOperation() {
      return this
    }
    setTimeout() {
      return this
    }
    build() {
      return { sign: (_kp: unknown) => undefined }
    }
  }

  return {
    rpc: {
      Server: FakeServer,
      Api: { isSimulationError: () => false },
    },
    Contract: FakeContract,
    TransactionBuilder: FakeTransactionBuilder,
    BASE_FEE: '100',
    nativeToScVal: (value: unknown) => ({ __scval: value }),
  }
}

before(() => {
  // Registered after MppSessionClient is loaded, so only close()'s call-time
  // dynamic import resolves to the fake (same ordering as dispute.test.ts).
  mock.module('@stellar/stellar-sdk', { namedExports: buildFakeSdk() })
})

// ── Global fetch stub for close()'s DELETE request ────────────────────────────

const originalFetch = globalThis.fetch

beforeEach(() => {
  fetchCallCount = 0
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ closeTxHash: 'CLOSE_TX_HASH' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof globalThis.fetch
})

after(() => {
  globalThis.fetch = originalFetch
  mock.restoreAll()
})

// ── Fixtures ──────────────────────────────────────────────────────────────────

function buildManifest(): RouteDockManifest {
  return {
    routedock: '1.0',
    name: 'Close Stream Test Provider',
    description: 'Provider exercised by session close stream tests',
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

function openHandle(
  options: SessionOptions,
  onSpend?: (amount: string) => Promise<void>,
) {
  const client = new MppSessionClient(agentKeypair, 'testnet')
  return client.openSession(
    SESSION_URL,
    buildManifest(),
    commitmentKeypair.secret(),
    options,
    onSpend,
  )
}

const isSessionClosed = (err: unknown): boolean =>
  err instanceof RouteDockChannelStateError &&
  /session closed/.test((err as Error).message)

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MppSessionClient.stream() after close()', () => {
  test('sequential stream (concurrency 1) issues no voucher after close()', async () => {
    let spendChecks = 0
    const handle = await openHandle({ maxDurationMs: 0 }, () => {
      spendChecks++
      return Promise.resolve()
    })
    const iter = handle.stream()[Symbol.asyncIterator]()

    await iter.next()
    await iter.next()
    assert.equal(fetchCallCount, 2, 'two pulls issue two vouchers')
    assert.equal(spendChecks, 2, 'the spend cap is checked per voucher')

    await handle.close()
    const fetchesAtClose = fetchCallCount
    const spendsAtClose = spendChecks

    // The next pull on the still-active iterator must not sign a voucher.
    await assert.rejects(() => iter.next(), isSessionClosed)
    assert.equal(fetchCallCount, fetchesAtClose, 'no mppx.fetch after close()')
    assert.equal(spendChecks, spendsAtClose, 'no checkSpend() after close()')
  })

  test('pipelined stream (concurrency 3) stops refilling after close()', async () => {
    const handle = await openHandle({ maxDurationMs: 0 })
    const iter = handle.stream({ concurrency: 3 })[Symbol.asyncIterator]()

    await iter.next()
    // The initial window is filled, plus one refill after the first yield.
    assert.equal(fetchCallCount, 4, 'window is filled before the first yield')

    await handle.close()
    const fetchesAtClose = fetchCallCount

    await assert.rejects(() => iter.next(), isSessionClosed)
    assert.equal(
      fetchCallCount,
      fetchesAtClose,
      'closed session must not queue another doFetch()',
    )
  })

  test('maxDurationMs auto-close ends the stream instead of issuing vouchers', async () => {
    const handle = await openHandle({ maxDurationMs: 20 })
    const iter = handle.stream()[Symbol.asyncIterator]()

    await iter.next()
    // Let the lifetime guard fire and its auto-close() settle.
    await new Promise((r) => setTimeout(r, 150))
    const fetchesAtTimeout = fetchCallCount

    await assert.rejects(() => iter.next(), isSessionClosed)
    assert.equal(fetchCallCount, fetchesAtTimeout)

    // Nothing else is issued on a later tick either.
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(fetchCallCount, fetchesAtTimeout)
  })

  test('a single-voucher stream that closes after one pull ends with the typed error', async () => {
    const handle = await openHandle({ maxDurationMs: 0 })
    const iter = handle.stream()[Symbol.asyncIterator]()

    await iter.next()
    await handle.close()

    await assert.rejects(
      () => iter.next(),
      (err: unknown) =>
        isSessionClosed(err) &&
        (err as Error).name === 'RouteDockChannelStateError',
    )
  })
})
