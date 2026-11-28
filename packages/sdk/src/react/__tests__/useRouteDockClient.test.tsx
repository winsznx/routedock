import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
GlobalRegistrator.register()
import * as RTL from '@testing-library/react'
const { renderHook } = RTL
import { Keypair } from '@stellar/stellar-sdk'
import { useRouteDockClient } from '../useRouteDockClient.js'
import { RouteDockClient, type RouteDockClientConfig, type VaultConfig } from '../../client/RouteDockClient.js'
import { signManifest } from '../../manifest/sign.js'
import { RouteDockSignatureError } from '../../errors.js'
import type { RouteDockManifest } from '../../types.js'

const wallet = Keypair.random().secret()

function renderWith(initial: RouteDockClientConfig) {
  return renderHook(({ config }: { config: RouteDockClientConfig }) => useRouteDockClient(config), {
    initialProps: { config: initial },
  })
}

function baseConfig(): RouteDockClientConfig {
  return { wallet, network: 'testnet' }
}

describe('useRouteDockClient', () => {
  it('returns a memoized RouteDockClient instance', () => {
    const { result, rerender } = renderHook(() =>
      useRouteDockClient({ wallet, network: 'testnet' }),
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

  it('keeps the same client for a structurally equal config with new object identities', () => {
    const payee = Keypair.random().publicKey()
    const { result, rerender } = renderWith({
      ...baseConfig(),
      spendCap: {
        daily: '1.00',
        asset: 'USDC',
        endpointCaps: {
          'https://api.example.com': '0.10',
          'https://b.example.com': '0.20',
        },
      },
      retryPolicy: { maxAttempts: 4, baseDelayMs: 250, maxDelayMs: 30_000 },
      expectedPayee: payee,
    })
    const first = result.current

    rerender({
      config: {
        ...baseConfig(),
        spendCap: {
          daily: '1.00',
          asset: 'USDC',
          endpointCaps: {
            'https://B.example.com/': '0.20',
            'https://api.example.com:443': '0.10',
          },
        },
        retryPolicy: { maxAttempts: 4, baseDelayMs: 250, maxDelayMs: 30_000 },
        expectedPayee: payee,
      },
    })

    assert.equal(result.current, first)
  })

  it('rebuilds when network changes', () => {
    const { result, rerender } = renderWith(baseConfig())
    const first = result.current

    rerender({ config: { ...baseConfig(), network: 'mainnet' } })

    assert.notEqual(result.current, first)
  })

  it('rebuilds when spendCap daily changes', () => {
    const { result, rerender } = renderWith({
      ...baseConfig(),
      spendCap: { daily: '1.00', asset: 'USDC' },
    })
    const first = result.current

    rerender({ config: { ...baseConfig(), spendCap: { daily: '2.00', asset: 'USDC' } } })
    const second = result.current
    assert.notEqual(second, first)

    rerender({ config: { ...baseConfig(), spendCap: { daily: '2.00', asset: 'USDC' } } })
    assert.equal(result.current, second)
  })

  it('rebuilds when spendCap.endpointCaps is added or changed', () => {
    const { result, rerender } = renderWith({
      ...baseConfig(),
      spendCap: { daily: '1.00', asset: 'USDC' },
    })
    const first = result.current

    rerender({
      config: {
        ...baseConfig(),
        spendCap: {
          daily: '1.00',
          asset: 'USDC',
          endpointCaps: { 'https://api.example.com': '0.10' },
        },
      },
    })
    assert.notEqual(result.current, first)

    const capped = result.current
    rerender({
      config: {
        ...baseConfig(),
        spendCap: {
          daily: '1.00',
          asset: 'USDC',
          endpointCaps: { 'https://api.example.com': '0.20' },
        },
      },
    })
    assert.notEqual(result.current, capped)
  })

  it('rebuilds when commitmentSecret changes', () => {
    const { result, rerender } = renderWith({ ...baseConfig(), commitmentSecret: Keypair.random().secret() })
    const first = result.current

    rerender({ config: { ...baseConfig(), commitmentSecret: Keypair.random().secret() } })

    assert.notEqual(result.current, first)
  })

  it('rebuilds when any retryPolicy scalar changes', () => {
    const { result, rerender } = renderWith({
      ...baseConfig(),
      retryPolicy: { maxAttempts: 4, baseDelayMs: 250, maxDelayMs: 30_000 },
    })
    const first = result.current

    rerender({
      config: { ...baseConfig(), retryPolicy: { maxAttempts: 5, baseDelayMs: 250, maxDelayMs: 30_000 } },
    })
    const afterAttempts = result.current
    assert.notEqual(afterAttempts, first)

    rerender({
      config: { ...baseConfig(), retryPolicy: { maxAttempts: 5, baseDelayMs: 300, maxDelayMs: 30_000 } },
    })
    const afterBaseDelay = result.current
    assert.notEqual(afterBaseDelay, afterAttempts)

    rerender({
      config: { ...baseConfig(), retryPolicy: { maxAttempts: 5, baseDelayMs: 300, maxDelayMs: 40_000 } },
    })
    assert.notEqual(result.current, afterBaseDelay)
  })

  it('rebuilds when retryPolicy callbacks change identity', () => {
    const onRetryA = () => {}
    const onRetryB = () => {}
    const loggerA = () => {}
    const loggerB = () => {}
    const { result, rerender } = renderWith({
      ...baseConfig(),
      retryPolicy: { onRetry: onRetryA, logger: loggerA },
    })
    const first = result.current

    rerender({ config: { ...baseConfig(), retryPolicy: { onRetry: onRetryB, logger: loggerA } } })
    const afterOnRetry = result.current
    assert.notEqual(afterOnRetry, first)

    rerender({ config: { ...baseConfig(), retryPolicy: { onRetry: onRetryB, logger: loggerB } } })
    assert.notEqual(result.current, afterOnRetry)
  })

  it('rebuilds when preSignHook identity changes', () => {
    const hookA = () => ({ approve: true } as const)
    const hookB = () => ({ approve: true } as const)
    const { result, rerender } = renderWith({ ...baseConfig(), preSignHook: hookA })
    const first = result.current

    rerender({ config: { ...baseConfig(), preSignHook: hookB } })

    assert.notEqual(result.current, first)
  })

  it('rebuilds when spendStore identity changes', () => {
    const storeA = { read: async () => null, write: async () => {} }
    const storeB = { read: async () => null, write: async () => {} }
    const { result, rerender } = renderWith({ ...baseConfig(), spendStore: storeA })
    const first = result.current

    rerender({ config: { ...baseConfig(), spendStore: storeB } })

    assert.notEqual(result.current, first)
  })

  it('rebuilds when logger identity changes', () => {
    const loggerA = () => {}
    const loggerB = () => {}
    const { result, rerender } = renderWith({ ...baseConfig(), logger: loggerA })
    const first = result.current

    rerender({ config: { ...baseConfig(), logger: loggerB } })

    assert.notEqual(result.current, first)
  })

  it('rebuilds when manifestTimeoutMs changes', () => {
    const { result, rerender } = renderWith({ ...baseConfig(), manifestTimeoutMs: 5000 })
    const first = result.current

    rerender({ config: { ...baseConfig(), manifestTimeoutMs: 10_000 } })

    assert.notEqual(result.current, first)
  })

  it('rebuilds when expectedPayee changes and enforces the new trust anchor', async () => {
    const signer = Keypair.random()
    const manifest: RouteDockManifest = {
      routedock: '1.0',
      name: 'Anchor Provider',
      description: 'Manifest used to verify expectedPayee enforcement',
      modes: ['x402'],
      network: 'testnet',
      asset: 'USDC',
      asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      payee: signer.publicKey(),
      pricing: { x402: { amount: '0.001', per: 'request', facilitator: 'https://facilitator.example' } },
      endpoints: { price: { method: 'GET', path: '/price' } },
      tags: ['test'],
    }
    const signed = signManifest(manifest, signer.secret())
    const origin = `https://anchor-${signer.publicKey().slice(0, 8)}.example`
    const fetchMock = mock.method(
      globalThis,
      'fetch',
      async () =>
        new Response(JSON.stringify(signed), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    )

    try {
      const { result, rerender } = renderWith(baseConfig())
      const first = result.current
      const wrongPayee = Keypair.random().publicKey()

      rerender({ config: { ...baseConfig(), expectedPayee: wrongPayee } })

      assert.notEqual(result.current, first)
      await assert.rejects(result.current.pay(`${origin}/price`), RouteDockSignatureError)
    } finally {
      fetchMock.mock.restore()
    }
  })

  it('rebuilds when vault config changes', () => {
    const vaultA: VaultConfig = {
      mode: 'nulth',
      nulthAccount: Keypair.random().publicKey(),
      witnessSecret: Keypair.random().secret(),
      allowedPayees: [Keypair.random().publicKey()],
      dailyCapUsdc: '1.00',
    }
    const { result, rerender } = renderWith({ ...baseConfig(), vault: vaultA })
    const first = result.current

    rerender({
      config: {
        ...baseConfig(),
        vault: {
          ...vaultA,
          nulthAccount: Keypair.random().publicKey(),
          allowedPayees: [...vaultA.allowedPayees, Keypair.random().publicKey()],
        },
      },
    })

    assert.notEqual(result.current, first)
  })
})
