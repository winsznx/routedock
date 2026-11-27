/**
 * Unit tests for MppSessionClient.stream() honoring close() (#398).
 *
 * A closed session — whether close() was called by the consumer or by the
 * maxDurationMs lifetime guard — must not issue another voucher. Every voucher
 * goes through mppx.fetch(), whose 402 challenge runs the spend check before
 * signing, so these tests count both and assert the counts freeze after
 * close().
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
import { Challenge } from 'mppx'
import type { RouteDockManifest, SessionOptions } from '../../types.js'
import type { WebSocketFactory } from '../MppSessionClient.js'

const CHANNEL_CONTRACT = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'
const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const SESSION_URL = 'https://provider.test/stream/orderbook'

// ── Executed mppx fetch counters ──────────────────────────────────────────────

/** Incremented once per mppx.fetch() — i.e. once per signed HTTP voucher. */
let fetchCallCount = 0
/** Incremented once per mpp-session-ws HTTP 402 probe. */
let rawFetchCallCount = 0
/** Incremented once per mpp-session-ws voucher credential signature. */
let createCredentialCallCount = 0

function buildWsProbeChallenge(): Challenge.Challenge {
  return Challenge.from({
    id: 'ws-probe-challenge',
    realm: 'provider.test',
    method: 'stellar',
    intent: 'channel',
    request: {
      amount: '1000',
      channel: CHANNEL_CONTRACT,
      methodDetails: { cumulativeAmount: '0' },
    },
  })
}

mock.module('@stellar/mpp/channel/client', {
  namedExports: {
    stellar: { channel: () => ({}) },
  },
})

type OnChallenge = (
  challenge: Challenge.Challenge,
  helpers: { createCredential: (context?: { cumulativeAmount?: string }) => Promise<string> },
) => Promise<string | undefined>

mock.module('mppx/client', {
  namedExports: {
    Mppx: {
      create: (config: { onChallenge?: OnChallenge }) => ({
        fetch: async (): Promise<Response> => {
          fetchCallCount++
          // Answer the provider's 402 the way mppx does, so the session's
          // guard and spend check run for every voucher.
          await config.onChallenge?.(
            Challenge.from({
              id: 'close-stream-test',
              realm: 'provider.test',
              method: 'stellar',
              intent: 'channel',
              request: { amount: '1000', channel: CHANNEL_CONTRACT },
            }),
            { createCredential: async () => 'Payment fake-credential' },
          )
          return new Response(JSON.stringify({ seq: fetchCallCount }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        },
        rawFetch: async (): Promise<Response> => {
          rawFetchCallCount++
          return new Response('', {
            status: 402,
            headers: { 'WWW-Authenticate': Challenge.serialize(buildWsProbeChallenge()) },
          })
        },
        createCredential: async (): Promise<string> => {
          createCredentialCallCount++
          return 'Payment ws-voucher-credential'
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
let deleteCallCount = 0

beforeEach(() => {
  fetchCallCount = 0
  rawFetchCallCount = 0
  createCredentialCallCount = 0
  deleteCallCount = 0
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'DELETE') {
      deleteCallCount++
    }
    return new Response(JSON.stringify({ closeTxHash: `CLOSE_TX_HASH_${deleteCallCount}` }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof globalThis.fetch
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
    modes: ['mpp-session', 'mpp-session-ws'],
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
      'mpp-session-ws': {
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
  webSocketFactory?: WebSocketFactory,
) {
  const client = new MppSessionClient(agentKeypair, 'testnet', undefined, webSocketFactory)
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
    assert.equal(spendChecks, spendsAtClose, 'no spend check after close()')
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

describe('SessionHandle.close() idempotency and WebSocket teardown (#726)', () => {
  test('calling close() twice sends one DELETE and both calls resolve to the same closeTxHash', async () => {
    // #given an open session handle
    const handle = await openHandle({ maxDurationMs: 0 })

    // #when close() is called sequentially twice
    const first = await handle.close()
    const second = await handle.close()

    // #then exactly one DELETE was sent and both return the same settlement result
    assert.equal(deleteCallCount, 1)
    assert.equal(second.closeTxHash, first.closeTxHash)
    assert.deepEqual(second, first)
  })

  test('auto-close followed by a manual close() sends one DELETE and the manual call resolves', async () => {
    // #given a session with a short maxDurationMs lifetime guard
    const handle = await openHandle({ maxDurationMs: 20 })
    let timedOut = false
    handle.on('session:timeout', () => {
      timedOut = true
    })

    // #when the lifetime guard fires and settles, then the caller calls close() manually
    await new Promise((r) => setTimeout(r, 120))
    assert.equal(timedOut, true)
    assert.equal(deleteCallCount, 1)

    const manual = await handle.close()

    // #then no second DELETE is sent and the manual close resolves cleanly
    assert.equal(deleteCallCount, 1)
    assert.equal(manual.closeTxHash, 'CLOSE_TX_HASH_1')
  })

  test('two concurrent close() calls send one DELETE and resolve to the same result', async () => {
    // #given a DELETE endpoint that stays in flight until released
    let releaseDelete!: () => void
    const deleteStarted = new Promise<void>((resolve) => {
      globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        if (init?.method === 'DELETE') {
          deleteCallCount++
          resolve()
          await new Promise<void>((r) => {
            releaseDelete = r
          })
        }
        return new Response(JSON.stringify({ closeTxHash: `CLOSE_TX_HASH_${deleteCallCount}` }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }) as typeof globalThis.fetch
    })

    const handle = await openHandle({ maxDurationMs: 0 })

    // #when two close() calls overlap in flight
    const firstPromise = handle.close()
    await deleteStarted
    const secondPromise = handle.close()
    releaseDelete()

    const [first, second] = await Promise.all([firstPromise, secondPromise])

    // #then only one DELETE was sent and both callers receive the same settlement
    assert.equal(deleteCallCount, 1)
    assert.equal(first.closeTxHash, 'CLOSE_TX_HASH_1')
    assert.equal(second.closeTxHash, first.closeTxHash)
  })

  test('a rejected close() can be retried and the retry sends a new DELETE', async () => {
    // #given a provider that rejects the first DELETE with HTTP 400 and succeeds on the second
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        deleteCallCount++
        if (deleteCallCount === 1) {
          return new Response(JSON.stringify({ error: 'temporary state error' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          })
        }
      }
      return new Response(JSON.stringify({ closeTxHash: `CLOSE_TX_HASH_${deleteCallCount}` }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }) as typeof globalThis.fetch

    const handle = await openHandle({ maxDurationMs: 0 })

    // #when the first close() fails and the caller retries
    await assert.rejects(() => handle.close(), RouteDockChannelStateError)
    assert.equal(deleteCallCount, 1)

    const retry = await handle.close()

    // #then the retry sends a second DELETE and succeeds, and a third call reuses that success
    assert.equal(deleteCallCount, 2)
    assert.equal(retry.closeTxHash, 'CLOSE_TX_HASH_2')
    const afterSuccess = await handle.close()
    assert.equal(deleteCallCount, 2)
    assert.equal(afterSuccess.closeTxHash, 'CLOSE_TX_HASH_2')
  })

  test('mpp-session-ws stream() after close() rejects with session closed, zero probes and zero onSpend calls', async () => {
    // #given a closed mpp-session-ws handle with an onSpend spy
    let spendChecks = 0
    let wsCreated = 0
    const wsFactory: WebSocketFactory = () => {
      wsCreated++
      return { readyState: 1, close: () => undefined }
    }
    const handle = await openHandle(
      { mode: 'mpp-session-ws', maxDurationMs: 0 },
      async () => {
        spendChecks++
      },
      wsFactory,
    )
    await handle.close()

    // #when stream() is consumed after close()
    const iter = handle.stream()[Symbol.asyncIterator]()
    await assert.rejects(() => iter.next(), isSessionClosed)

    // #then zero spend checks, zero HTTP probes, zero credentials, and zero sockets were created
    assert.equal(spendChecks, 0)
    assert.equal(rawFetchCallCount, 0)
    assert.equal(createCredentialCallCount, 0)
    assert.equal(wsCreated, 0)
  })

  test('calling close() while an mpp-session-ws WebSocket is open sends close(1000, ...) and ends the stream', async () => {
    // #given an active mpp-session-ws stream holding an open socket
    const socketCloses: Array<{ code: number | undefined; reason: string | undefined }> = []
    let opened!: () => void
    const wsOpened = new Promise<void>((resolve) => {
      opened = resolve
    })

    const wsFactory: WebSocketFactory = (_url, _init, handlers) => {
      const socket = {
        readyState: 0,
        close: (code?: number, reason?: string) => {
          socketCloses.push({ code, reason })
          socket.readyState = 3
        },
      }
      queueMicrotask(() => {
        socket.readyState = 1
        handlers.onOpen()
        handlers.onMessage(JSON.stringify({ tick: 1 }))
        opened()
      })
      return socket
    }

    const handle = await openHandle({ mode: 'mpp-session-ws', maxDurationMs: 0 }, undefined, wsFactory)
    const iter = handle.stream()[Symbol.asyncIterator]()

    const first = await iter.next()
    assert.deepEqual(first, { value: { tick: 1 }, done: false })
    await wsOpened

    // #when close() is called while the WebSocket is still open and the consumer awaits the next frame
    const nextPull = iter.next()
    const closeResult = await handle.close()
    const afterClose = await nextPull

    // #then the socket received close(1000, ...), the stream ended cleanly, and one DELETE settled
    assert.equal(socketCloses.length, 1)
    assert.equal(socketCloses[0]!.code, 1000)
    assert.equal(afterClose.done, true)
    assert.equal(deleteCallCount, 1)
    assert.equal(closeResult.closeTxHash, 'CLOSE_TX_HASH_1')
  })
})
