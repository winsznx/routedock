/**
 * Unit tests for #398: MppSessionClient.stream() must stop issuing vouchers
 * once the session is closed — whether close() was called by the caller or the
 * maxDurationMs lifetime guard fired it.
 *
 * Before the fix the `closed` flag was only read by the timer callback, so a
 * consumer that kept pulling from an active iterator still ran checkSpend() and
 * mppx.fetch(), signing ever-higher cumulative vouchers after close().
 *
 * mppx/client is mocked before the SUT is imported (same pattern as
 * session-stats.test.ts) so every fetch is counted locally. close()'s dynamic
 * `import('@stellar/stellar-sdk')` resolves to a fake RPC layer and the close
 * DELETE goes to a stubbed global fetch, so the whole file runs offline.
 *
 * Run with: pnpm --filter @routedock/routedock test
 * (requires --experimental-test-module-mocks, set in the package test script)
 */

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it, mock } from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import { RouteDockChannelStateError } from '../../types.js'
import type { RouteDockManifest } from '../../types.js'

const CHANNEL_CONTRACT = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'
const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const SESSION_URL = 'https://provider.test/stream/orderbook'

// ── Scripted mppx client ─────────────────────────────────────────────────────

/** Every voucher request the SUT issues goes through this counter. */
let fetchCalls = 0

mock.module('mppx/client', {
  namedExports: {
    Mppx: {
      create: () => ({
        fetch: async (): Promise<Response> => {
          fetchCalls++
          return new Response(JSON.stringify({ seq: fetchCalls }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        },
      }),
    },
  },
})

const { MppSessionClient } = await import('../MppSessionClient.js')

// ── Fake Stellar RPC for close() ─────────────────────────────────────────────
// Only the dynamic import inside close() resolves here; the SUT's static
// @stellar/stellar-sdk imports were bound before this mock is registered.

function buildFakeSdk() {
  class FakeServer {
    constructor(_url: string) {}
    async getAccount(publicKey: string) {
      return {
        accountId: () => publicKey,
        sequenceNumber: () => '1',
        incrementSequenceNumber: () => undefined,
      }
    }
    async simulateTransaction(_tx: unknown) {
      return { result: { retval: { bytes: () => Buffer.from('commitment-bytes') } } }
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
      return {}
    }
  }

  return {
    rpc: { Server: FakeServer, Api: { isSimulationError: () => false } },
    Contract: FakeContract,
    TransactionBuilder: FakeTransactionBuilder,
    BASE_FEE: '100',
    nativeToScVal: (value: unknown) => ({ __scval: value }),
  }
}

const originalFetch = globalThis.fetch

before(() => {
  mock.module('@stellar/stellar-sdk', { namedExports: buildFakeSdk() })
  // close()'s DELETE is the only consumer of global fetch in this file.
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ closeTxHash: 'CLOSE_TX_HASH' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch
})

after(() => {
  globalThis.fetch = originalFetch
  mock.restoreAll()
})

beforeEach(() => {
  fetchCalls = 0
})

// ── Fixtures ─────────────────────────────────────────────────────────────────

function buildManifest(): RouteDockManifest {
  return {
    routedock: '1.0',
    name: 'Close Stream Test Provider',
    description: 'Provider exercised by the close-stops-stream unit tests',
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

function openHandle(maxDurationMs?: number) {
  const client = new MppSessionClient(Keypair.random(), 'testnet')
  const options = maxDurationMs === undefined ? undefined : { maxDurationMs }
  return client.openSession(
    SESSION_URL,
    buildManifest(),
    Keypair.random().secret(),
    options,
  )
}

const isSessionClosed = (err: unknown): boolean =>
  err instanceof RouteDockChannelStateError && /session closed/.test(err.message)

// ── Tests ────────────────────────────────────────────────────────────────────

describe('stream() stops after close() (#398)', () => {
  it('sequential: the next pull ends the iteration without touching the provider', async () => {
    // #given a sequential session that has issued two vouchers
    const handle = await openHandle()
    const iter = handle.stream()[Symbol.asyncIterator]()
    await iter.next()
    await iter.next()
    assert.equal(fetchCalls, 2)

    // #when the session is closed
    await handle.close()

    // #then the next pull ends with a typed error and issues no voucher
    await assert.rejects(() => iter.next(), isSessionClosed)
    assert.equal(fetchCalls, 2, 'close() must not stop the stream from fetching again')
  })

  it('sequential: a spend check does not run after close()', async () => {
    // #given an onSpend spy counting every cap check
    let spendChecks = 0
    const client = new MppSessionClient(Keypair.random(), 'testnet')
    const handle = await client.openSession(
      SESSION_URL,
      buildManifest(),
      Keypair.random().secret(),
      undefined,
      async () => {
        spendChecks++
      },
    )
    const iter = handle.stream()[Symbol.asyncIterator]()
    await iter.next()
    assert.equal(spendChecks, 1)

    // #when the session is closed
    await handle.close()

    // #then no further cap check runs
    await assert.rejects(() => iter.next(), isSessionClosed)
    assert.equal(spendChecks, 1, 'checkSpend must not run once the session is closed')
  })

  it('pipelined: close() stops refilling the in-flight window', async () => {
    // #given a pipelined session (concurrency 3) with two results consumed
    const handle = await openHandle()
    const iter = handle.stream({ concurrency: 3 })[Symbol.asyncIterator]()
    await iter.next()
    await iter.next()
    // 3 seeded + one refill per pull
    assert.equal(fetchCalls, 5)

    // #when the session is closed
    await handle.close()
    const atClose = fetchCalls

    // #then no replacement voucher is queued and the iterator ends
    await assert.rejects(() => iter.next(), isSessionClosed)
    assert.equal(fetchCalls, atClose, 'no doFetch may be queued after close()')
  })

  it('pipelined: the initial window is not filled once the session is closed', async () => {
    // #given a pipelined session closed before its first pull
    const handle = await openHandle()
    await handle.close()

    // #when the consumer starts iterating
    const iter = handle.stream({ concurrency: 3 })[Symbol.asyncIterator]()

    // #then the stream ends immediately without seeding its window
    await assert.rejects(() => iter.next(), isSessionClosed)
    assert.equal(fetchCalls, 0)
  })

  it('the maxDurationMs auto-close stops the stream too', async () => {
    // #given a session with a short lifetime guard and one consumed voucher
    const handle = await openHandle(20)
    const iter = handle.stream()[Symbol.asyncIterator]()
    await iter.next()
    assert.equal(fetchCalls, 1)

    // #when the guard fires and auto-closes
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('session:timeout never fired')), 1000)
      handle.on('session:timeout', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    // Let the auto-close's close() run past its synchronous `closed = true`.
    await new Promise((r) => setTimeout(r, 30))

    // #then the stream ends instead of signing another voucher
    await assert.rejects(() => iter.next(), isSessionClosed)
    assert.equal(fetchCalls, 1)
  })
})
