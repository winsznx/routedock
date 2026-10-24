import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
GlobalRegistrator.register()
import * as RTL from '@testing-library/react'
const { renderHook, act, waitFor } = RTL
import { Keypair } from '@stellar/stellar-sdk'
import { createElement, type ReactNode } from 'react'
import { RouteDockClient } from '../../client/RouteDockClient.js'
import { RouteDockProvider } from '../context.js'
import { useSession } from '../useSession.js'
import type { SessionHandle, SessionCloseResult } from '../../types.js'

function mockSession(onClose?: () => void): SessionHandle {
  return {
    channelId: 'C123',
    openTxHash: 'open-hash',
    async *stream() {},
    async close(): Promise<SessionCloseResult> {
      onClose?.()
      return { closeTxHash: 'close-hash', totalPaid: '0.005', vouchersIssued: 5 }
    },
    async requestRefund() { return 'refund-hash' },
    async settleWithLatestVoucher() { return 'settle-hash' },
    async getDisputeStatus() { return 'open' },
    on() { return () => {} },
    stats() {
      return { vouchersIssued: 0, currentCumulative: '0.0000000', channelId: 'C123', openTxHash: 'open-hash' }
    },
  }
}

function wrapper(client: RouteDockClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(RouteDockProvider, { client, children })
}

describe('useSession', () => {
  it('open → close transitions status and records vouchers', async () => {
    const client = new RouteDockClient({
      wallet: Keypair.random().secret(),
      network: 'testnet',
      commitmentSecret: Keypair.random().secret(),
    })
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

  it('closes a handle that resolves after the hook unmounts', async () => {
    let resolveOpen!: (session: SessionHandle) => void
    let closeCalls = 0
    const opening = new Promise<SessionHandle>((resolve) => { resolveOpen = resolve })
    const client = new RouteDockClient({ wallet: Keypair.random().secret(), network: 'testnet', commitmentSecret: Keypair.random().secret() })
    client.openSession = async () => opening
    const { result, unmount } = renderHook(() => useSession('https://x.test/stream'), { wrapper: wrapper(client) })
    const openPromise = result.current.open()
    unmount()
    resolveOpen(mockSession(() => { closeCalls += 1 }))
    assert.equal(await openPromise, null)
    assert.equal(closeCalls, 1)
  })

  it('deduplicates concurrent opens and reuses an open session', async () => {
    let openCalls = 0
    let resolveOpen!: (session: SessionHandle) => void
    const opening = new Promise<SessionHandle>((resolve) => { resolveOpen = resolve })
    const session = mockSession()
    const client = new RouteDockClient({ wallet: Keypair.random().secret(), network: 'testnet', commitmentSecret: Keypair.random().secret() })
    client.openSession = async () => { openCalls += 1; return opening }
    const { result } = renderHook(() => useSession('https://x.test/stream'), { wrapper: wrapper(client) })
    const first = result.current.open()
    const second = result.current.open()
    resolveOpen(session)
    assert.equal(await first, session)
    assert.equal(await second, session)
    assert.equal(openCalls, 1)
    assert.equal(await result.current.open(), session)
    assert.equal(openCalls, 1)
  })

  it('allows a new open after close', async () => {
    let openCalls = 0
    const client = new RouteDockClient({ wallet: Keypair.random().secret(), network: 'testnet', commitmentSecret: Keypair.random().secret() })
    client.openSession = async () => { openCalls += 1; return mockSession() }
    const { result } = renderHook(() => useSession('https://x.test/stream'), { wrapper: wrapper(client) })
    await act(async () => { await result.current.open() })
    await act(async () => { await result.current.close() })
    await act(async () => { await result.current.open() })
    assert.equal(openCalls, 2)
  })
})
