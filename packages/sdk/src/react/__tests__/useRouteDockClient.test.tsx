import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
GlobalRegistrator.register()
import * as RTL from '@testing-library/react'
const { renderHook } = RTL
import { Keypair } from '@stellar/stellar-sdk'
import { useRouteDockClient } from '../useRouteDockClient.js'
import { RouteDockClient } from '../../client/RouteDockClient.js'

describe('useRouteDockClient', () => {
  it('returns a memoized RouteDockClient instance', () => {
    const secret = Keypair.random().secret()
    const { result, rerender } = renderHook(() =>
      useRouteDockClient({ wallet: secret, network: 'testnet' }),
    )
    const first = result.current

    rerender()

    assert.ok(first instanceof RouteDockClient)
    assert.equal(result.current, first, 'identity is stable across rerenders')
  })

  it('rebuilds when wallet changes', () => {
    const a = Keypair.random().secret()
    const b = Keypair.random().secret()
    const { result, rerender } = renderHook(
      ({ secret }: { secret: string }) =>
        useRouteDockClient({ wallet: secret, network: 'testnet' }),
      { initialProps: { secret: a } },
    )
    const first = result.current

    rerender({ secret: b })

    assert.notEqual(result.current, first)
  })

  it('does not dispose the mounted client during StrictMode effect replay', () => {
    const secret = Keypair.random().secret()
    const originalDispose = RouteDockClient.prototype.dispose
    const disposed: RouteDockClient[] = []
    RouteDockClient.prototype.dispose = function () { disposed.push(this) }
    try {
      const { result } = renderHook(
        () => useRouteDockClient({ wallet: secret, network: 'testnet', commitmentSecret: secret }),
        { reactStrictMode: true },
      )
      assert.equal(disposed.length, 0)
      assert.ok(result.current instanceof RouteDockClient)
    } finally {
      RouteDockClient.prototype.dispose = originalDispose
    }
  })

  it('disposes the previous client once when configuration changes', () => {
    const a = Keypair.random().secret()
    const b = Keypair.random().secret()
    const originalDispose = RouteDockClient.prototype.dispose
    const disposed: RouteDockClient[] = []
    RouteDockClient.prototype.dispose = function () { disposed.push(this) }
    try {
      const { result, rerender } = renderHook(
        ({ secret }: { secret: string }) =>
          useRouteDockClient({ wallet: secret, network: 'testnet', commitmentSecret: secret }),
        { initialProps: { secret: a }, reactStrictMode: true },
      )
      const first = result.current
      rerender({ secret: b })
      assert.deepEqual(disposed, [first])
      assert.notEqual(result.current, first)
    } finally {
      RouteDockClient.prototype.dispose = originalDispose
    }
  })
})
