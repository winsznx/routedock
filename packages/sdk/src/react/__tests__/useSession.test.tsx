import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
GlobalRegistrator.register()
import * as RTL from '@testing-library/react'
const { renderHook, act, waitFor } = RTL
import { Keypair } from '@stellar/stellar-sdk'
import { createElement, useEffect, type ReactNode } from 'react'
import { RouteDockClient } from '../../client/RouteDockClient.js'
import { RouteDockProvider } from '../context.js'
import { useSession } from '../useSession.js'
import type { SessionHandle, SessionCloseResult } from '../../types.js'

function mockSession(overrides: Partial<SessionHandle> = {}): SessionHandle {
  return {
    channelId: 'C123',
    openTxHash: 'open-hash',
    async *stream() {},
    async close(): Promise<SessionCloseResult> {
      return { closeTxHash: 'close-hash', totalPaid: '0.005', vouchersIssued: 5 }
    },
    async requestRefund() { return 'refund-hash' },
    async settleWithLatestVoucher() { return 'settle-hash' },
    async getDisputeStatus() { return 'open' },
    on() { return () => {} },
    stats() {
      return { vouchersIssued: 0, currentCumulative: '0.0000000', channelId: 'C123', openTxHash: 'open-hash' }
    },
    ...overrides,
  }
}

function makeClient(): RouteDockClient {
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
    client.openSession = async () => mockSession()

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
    assert.equal(result.current.vouchers, 5)
    assert.equal(result.current.cumulative, '0.005')
  })

  it('closes the resolved session handle if the hook unmounts while open() is pending', async () => {
    const client = makeClient()
    let closeCalls = 0
    let resolveOpen!: (s: SessionHandle) => void
    client.openSession = () =>
      new Promise<SessionHandle>((resolve) => {
        resolveOpen = resolve
      })

    const { result, unmount } = renderHook(() => useSession('https://x.test/stream'), {
      wrapper: wrapper(client),
    })

    let openPromise!: Promise<SessionHandle | null>
    act(() => {
      openPromise = result.current.open()
    })

    unmount()

    const handle = mockSession({
      async close() {
        closeCalls += 1
        return { closeTxHash: 'close-hash', totalPaid: '0', vouchersIssued: 0 }
      },
    })
    resolveOpen(handle)

    const resolved = await openPromise
    assert.equal(resolved, null)
    assert.equal(closeCalls, 1)
  })

  it('deduplicates concurrent open() calls and resolves both to the same handle', async () => {
    const client = makeClient()
    let openCalls = 0
    let resolveOpen!: (s: SessionHandle) => void
    client.openSession = () => {
      openCalls += 1
      return new Promise<SessionHandle>((resolve) => {
        resolveOpen = resolve
      })
    }

    const { result } = renderHook(() => useSession('https://x.test/stream'), {
      wrapper: wrapper(client),
    })

    let p1!: Promise<SessionHandle | null>
    let p2!: Promise<SessionHandle | null>
    act(() => {
      p1 = result.current.open()
      p2 = result.current.open()
    })

    const handle = mockSession()
    await act(async () => {
      resolveOpen(handle)
      const [r1, r2] = await Promise.all([p1, p2])
      assert.equal(r1, handle)
      assert.equal(r2, handle)
    })

    assert.equal(openCalls, 1)
    assert.equal(result.current.status, 'open')
  })

  it('returns the existing handle when open() is called while already open', async () => {
    const client = makeClient()
    let openCalls = 0
    const handle = mockSession()
    client.openSession = async () => {
      openCalls += 1
      return handle
    }

    const { result } = renderHook(() => useSession('https://x.test/stream'), {
      wrapper: wrapper(client),
    })

    await act(async () => {
      const first = await result.current.open()
      assert.equal(first, handle)
    })

    await act(async () => {
      const second = await result.current.open()
      assert.equal(second, handle)
    })

    assert.equal(openCalls, 1)
  })

  it('allows opening a new session after close() completes', async () => {
    const client = makeClient()
    let openCalls = 0
    client.openSession = async () => {
      openCalls += 1
      return mockSession({ channelId: `C-${openCalls}` })
    }

    const { result } = renderHook(() => useSession('https://x.test/stream'), {
      wrapper: wrapper(client),
    })

    await act(async () => {
      await result.current.open()
    })
    assert.equal(result.current.session?.channelId, 'C-1')

    await act(async () => {
      await result.current.close()
    })
    assert.equal(result.current.status, 'closed')

    await act(async () => {
      await result.current.open()
    })
    assert.equal(openCalls, 2)
    assert.equal(result.current.status, 'open')
    assert.equal(result.current.session?.channelId, 'C-2')
  })

  it('opens once and closes once on final unmount under React StrictMode', async () => {
    const client = makeClient()
    let openCalls = 0
    let closeCalls = 0
    client.openSession = async () => {
      openCalls += 1
      return mockSession({
        async close() {
          closeCalls += 1
          return { closeTxHash: 'close-hash', totalPaid: '0.005', vouchersIssued: 5 }
        },
      })
    }

    const { result, unmount } = renderHook(
      () => {
        const s = useSession('https://x.test/stream')
        useEffect(() => {
          void s.open()
        }, [s.open])
        return s
      },
      {
        wrapper: wrapper(client),
        reactStrictMode: true,
      },
    )

    await waitFor(() => assert.equal(result.current.status, 'open'))
    assert.equal(openCalls, 1)
    assert.equal(closeCalls, 0)

    unmount()
    assert.equal(closeCalls, 1)
  })
})
