import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
GlobalRegistrator.register()
import * as RTL from '@testing-library/react'
const { renderHook, act, waitFor } = RTL
import { Keypair } from '@stellar/stellar-sdk'
import { createElement, type ReactNode } from 'react'
import { RouteDockClient } from '../../client/RouteDockClient.js'
import { RouteDockChannelStateError } from '../../errors.js'
import { RouteDockProvider } from '../context.js'
import { useSession } from '../useSession.js'
import type {
  SessionCloseResult,
  SessionEvent,
  SessionEventPayloadMap,
  SessionHandle,
  SessionOptions,
  StreamOptions,
} from '../../types.js'

interface MockSessionController {
  handle: SessionHandle
  emit: <E extends SessionEvent>(event: E, payload: SessionEventPayloadMap[E]) => void
  getCloseCalls: () => number
  getStreamOptionsCalls: () => Array<StreamOptions | undefined>
  getListenerCount: (event: SessionEvent) => number
  setStats: (vouchersIssued: number, currentCumulative: string) => void
}

function createMockSession(opts: {
  items?: Array<{ value: unknown; vouchersIssued: number; currentCumulative: string }>
  closeResult?: SessionCloseResult
} = {}): MockSessionController {
  let vouchersIssued = 0
  let currentCumulative = '0.0000000'
  let closeCalls = 0
  const streamOptionsCalls: Array<StreamOptions | undefined> = []
  const listeners = new Map<SessionEvent, Set<(payload: never) => void>>()
  const closeResult: SessionCloseResult = opts.closeResult ?? {
    closeTxHash: 'close-hash',
    totalPaid: '0.005',
    vouchersIssued: 5,
  }

  const handle: SessionHandle = {
    channelId: 'C123',
    openTxHash: 'open-hash',
    async *stream(streamOptions?: StreamOptions) {
      streamOptionsCalls.push(streamOptions)
      for (const step of opts.items ?? []) {
        vouchersIssued = step.vouchersIssued
        currentCumulative = step.currentCumulative
        yield step.value
      }
    },
    async close(): Promise<SessionCloseResult> {
      closeCalls++
      return closeResult
    },
    async requestRefund() { return 'refund-hash' },
    async settleWithLatestVoucher() { return 'settle-hash' },
    async getDisputeStatus() { return 'open' },
    on<E extends SessionEvent>(
      event: E,
      listener: (payload: SessionEventPayloadMap[E]) => void,
    ) {
      let set = listeners.get(event)
      if (!set) {
        set = new Set()
        listeners.set(event, set)
      }
      const stored = listener as (payload: never) => void
      set.add(stored)
      return () => {
        set?.delete(stored)
      }
    },
    stats() {
      return { vouchersIssued, currentCumulative, channelId: 'C123', openTxHash: 'open-hash' }
    },
  }

  return {
    handle,
    emit<E extends SessionEvent>(event: E, payload: SessionEventPayloadMap[E]) {
      for (const listener of listeners.get(event) ?? []) {
        ;(listener as (p: SessionEventPayloadMap[E]) => void)(payload)
      }
    },
    getCloseCalls: () => closeCalls,
    getStreamOptionsCalls: () => streamOptionsCalls,
    getListenerCount: (event: SessionEvent) => listeners.get(event)?.size ?? 0,
    setStats(v: number, c: string) {
      vouchersIssued = v
      currentCumulative = c
    },
  }
}

function makeClient() {
  return new RouteDockClient({
    wallet: Keypair.random().secret(),
    network: 'testnet',
    commitmentSecret: Keypair.random().secret(),
  })
}

function wrapper(client: RouteDockClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(RouteDockProvider, { client, children })
}

describe('useSession', () => {
  it('open → close transitions status and records vouchers', async () => {
    const client = makeClient()
    const mock = createMockSession()
    client.openSession = async () => mock.handle

    const { result } = renderHook(() => useSession('https://x.test/stream'), {
      wrapper: wrapper(client),
    })
    await act(async () => {
      await result.current.open()
    })

    await waitFor(() => assert.equal(result.current.status, 'open'))
    assert.equal(result.current.session?.channelId, 'C123')

    await act(async () => {
      await result.current.close()
    })

    assert.equal(result.current.status, 'closed')
    assert.equal(result.current.session, null)
    assert.equal(result.current.vouchers, 5)
    assert.equal(result.current.cumulative, '0.005')
  })

  it('forwards SessionOptions to client.openSession and keeps open stable across equivalent inline options', async () => {
    // #given a client capturing openSession arguments
    const client = makeClient()
    const mock = createMockSession()
    const calls: Array<{ url: string; options: SessionOptions | undefined }> = []
    client.openSession = async (url, options) => {
      calls.push({ url, options })
      return mock.handle
    }

    // #when rendered with inline SessionOptions and re-rendered with an equal object literal
    const { result, rerender } = renderHook(
      ({ maxDurationMs }: { maxDurationMs: number }) =>
        useSession('https://x.test/stream', { mode: 'mpp-session-ws', maxDurationMs }),
      {
        wrapper: wrapper(client),
        initialProps: { maxDurationMs: 60_000 },
      },
    )
    const firstOpen = result.current.open
    rerender({ maxDurationMs: 60_000 })
    assert.equal(result.current.open, firstOpen, 'open callback stays stable for equal option values')

    await act(async () => {
      await result.current.open()
    })

    // #then openSession received the exact SessionOptions
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.url, 'https://x.test/stream')
    assert.deepEqual(calls[0]!.options, { mode: 'mpp-session-ws', maxDurationMs: 60_000 })
  })

  it('updates vouchers and cumulative live after each item yielded by stream() and via refreshStats()', async () => {
    // #given a handle that yields three items with incrementing stats
    const client = makeClient()
    const mock = createMockSession({
      items: [
        { value: { tick: 1 }, vouchersIssued: 1, currentCumulative: '0.0001000' },
        { value: { tick: 2 }, vouchersIssued: 2, currentCumulative: '0.0002000' },
        { value: { tick: 3 }, vouchersIssued: 3, currentCumulative: '0.0003000' },
      ],
    })
    client.openSession = async () => mock.handle

    const { result } = renderHook(() => useSession('https://x.test/stream'), {
      wrapper: wrapper(client),
    })

    // Calling stream() before open() rejects with RouteDockChannelStateError
    await assert.rejects(async () => {
      const iter = result.current.stream()[Symbol.asyncIterator]()
      await iter.next()
    }, RouteDockChannelStateError)

    await act(async () => {
      await result.current.open()
    })

    // #when iterating item by item through the hook's stream() wrapper
    const iter = result.current.stream({ concurrency: 2 })[Symbol.asyncIterator]()
    const seen: unknown[] = []

    await act(async () => {
      const next = await iter.next()
      seen.push(next.value)
    })
    assert.equal(result.current.vouchers, 1)
    assert.equal(result.current.cumulative, '0.0001000')

    await act(async () => {
      const next = await iter.next()
      seen.push(next.value)
    })
    assert.equal(result.current.vouchers, 2)
    assert.equal(result.current.cumulative, '0.0002000')

    await act(async () => {
      const next = await iter.next()
      seen.push(next.value)
    })
    assert.equal(result.current.vouchers, 3)
    assert.equal(result.current.cumulative, '0.0003000')

    await act(async () => {
      const done = await iter.next()
      assert.equal(done.done, true)
    })

    // #then stream options were forwarded, all items yielded, and refreshStats() pulls direct updates
    assert.deepEqual(seen, [{ tick: 1 }, { tick: 2 }, { tick: 3 }])
    assert.deepEqual(mock.getStreamOptionsCalls(), [{ concurrency: 2 }])

    mock.setStats(4, '0.0004000')
    act(() => {
      result.current.refreshStats()
    })
    assert.equal(result.current.vouchers, 4)
    assert.equal(result.current.cumulative, '0.0004000')
  })

  it('handles session:timeout → session:closed and avoids calling handle.close() on later close() or unmount', async () => {
    // #given an open session that auto-closes via lifecycle events
    const client = makeClient()
    const autoCloseResult: SessionCloseResult = {
      closeTxHash: 'auto-close-tx',
      totalPaid: '0.0003000',
      vouchersIssued: 3,
    }
    const mock = createMockSession()
    client.openSession = async () => mock.handle

    const { result, unmount } = renderHook(() => useSession('https://x.test/stream'), {
      wrapper: wrapper(client),
    })
    await act(async () => {
      await result.current.open()
    })
    assert.equal(result.current.status, 'open')

    // #when session:timeout fires
    act(() => {
      mock.emit('session:timeout', { maxDurationMs: 60_000 })
    })
    assert.equal(result.current.status, 'closing')

    // #when auto-close succeeds and emits session:closed
    act(() => {
      mock.emit('session:closed', autoCloseResult)
    })

    // #then status is closed, session is cleared, stats reflect settlement, and listeners are cleaned up
    assert.equal(result.current.status, 'closed')
    assert.equal(result.current.session, null)
    assert.equal(result.current.vouchers, 3)
    assert.equal(result.current.cumulative, '0.0003000')
    assert.equal(mock.getListenerCount('session:timeout'), 0)
    assert.equal(mock.getListenerCount('session:closed'), 0)
    assert.equal(mock.getListenerCount('session:close-failed'), 0)

    // #when manual close() is called after auto-close and component unmounts
    let returned: SessionCloseResult | null = null
    await act(async () => {
      returned = await result.current.close()
    })
    unmount()

    // #then stored close result is returned without calling handle.close() at all
    assert.deepEqual(returned, autoCloseResult)
    assert.equal(mock.getCloseCalls(), 0)
  })

  it('sets error and status=error on session:close-failed and still allows a manual close() retry', async () => {
    // #given an open session whose auto-close fails
    const client = makeClient()
    const mock = createMockSession({
      closeResult: { closeTxHash: 'manual-retry-tx', totalPaid: '0.0002000', vouchersIssued: 2 },
    })
    client.openSession = async () => mock.handle

    const { result } = renderHook(() => useSession('https://x.test/stream'), {
      wrapper: wrapper(client),
    })
    await act(async () => {
      await result.current.open()
    })

    // #when session:timeout then session:close-failed fire
    const failure = new Error('auto-close RPC down')
    act(() => {
      mock.emit('session:timeout', { maxDurationMs: 60_000 })
      mock.emit('session:close-failed', { maxDurationMs: 60_000, error: failure })
    })

    // #then error and status='error' are exposed to the component
    assert.equal(result.current.status, 'error')
    assert.equal(result.current.error, failure)

    // #when the user retries close() manually
    let retryResult: SessionCloseResult | null = null
    await act(async () => {
      retryResult = await result.current.close()
    })

    // #then the manual retry succeeds and clears error
    assert.equal(mock.getCloseCalls(), 1)
    assert.equal(result.current.status, 'closed')
    assert.equal(result.current.error, null)
    assert.deepEqual(retryResult, {
      closeTxHash: 'manual-retry-tx',
      totalPaid: '0.0002000',
      vouchersIssued: 2,
    })
  })
})
