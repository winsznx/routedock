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

function mockSession(): SessionHandle {
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
})
