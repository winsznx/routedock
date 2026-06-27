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
import { usePay } from '../usePay.js'
import type { PaymentResult } from '../../types.js'

function wrapper(client: RouteDockClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(RouteDockProvider, { client, children })
}

describe('usePay', () => {
  it('transitions loading → result on success', async () => {
    const client = new RouteDockClient({
      wallet: Keypair.random().secret(),
      network: 'testnet',
    })
    const fake: PaymentResult = {
      data: { ok: true },
      txHash: 'abc',
      mode: 'x402',
      amount: '0.001',
      timestamp: Date.now(),
    }
    client.pay = async () => fake

    const { result } = renderHook(() => usePay('https://x.test/price'), {
      wrapper: wrapper(client),
    })
    await act(async () => {
      await result.current.pay()
    })

    await waitFor(() => assert.equal(result.current.loading, false))
    assert.equal(result.current.result, fake)
    assert.equal(result.current.error, null)
  })

  it('captures errors', async () => {
    const client = new RouteDockClient({
      wallet: Keypair.random().secret(),
      network: 'testnet',
    })
    client.pay = async () => {
      throw new Error('boom')
    }

    const { result } = renderHook(() => usePay('https://x.test/price'), {
      wrapper: wrapper(client),
    })
    await act(async () => {
      await result.current.pay()
    })

    assert.ok(result.current.error instanceof Error)
    assert.equal(result.current.error?.message, 'boom')
    assert.equal(result.current.loading, false)
  })
})
