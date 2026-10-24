/**
 * Tests for ProviderRegistry network derivation and the manifest↔payee
 * cross-check that closes the self-signed trust gap (issue #146).
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { createServer } from 'node:http'
import { Keypair } from '@stellar/stellar-sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ProviderRegistry, deriveNetwork, type ProviderRecord } from '../ProviderRegistry.js'
import { signManifest } from '../../manifest/sign.js'
import { RouteDockSignatureError } from '../../errors.js'
import type { RouteDockManifest } from '../../types.js'

const payeeKeypair = Keypair.random()
const attackerKeypair = Keypair.random()

const validManifest: RouteDockManifest = {
  routedock: '1.0',
  name: 'Test Provider',
  description: 'Unit test provider',
  modes: ['x402'],
  network: 'testnet',
  asset: 'USDC',
  asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
  payee: payeeKeypair.publicKey(),
  pricing: { x402: { amount: '0.001', per: 'request' } },
  endpoints: { price: { method: 'GET', path: '/price' } },
  tags: ['test'],
}

const signedManifest = signManifest(validManifest, payeeKeypair.secret())

function recordFor(baseUrl: string, payee: string): ProviderRecord {
  return {
    name: 'Test',
    description: 'desc',
    base_url: baseUrl,
    modes: ['x402'],
    tags: ['test'],
    network: 'testnet',
    payee,
    source: 'onchain',
    verified: true,
  }
}

describe('deriveNetwork', () => {
  it('derives testnet from a horizon-testnet URL', () => {
    assert.equal(deriveNetwork('https://horizon-testnet.stellar.org'), 'testnet')
  })

  it('defaults to mainnet for production horizon', () => {
    assert.equal(deriveNetwork('https://horizon.stellar.org'), 'mainnet')
    assert.equal(deriveNetwork('https://example.com/unknown'), 'mainnet')
  })
})

describe('ProviderRegistry.fetchProviderManifest', () => {
  let server: ReturnType<typeof createServer>
  let baseUrl: string

  before(async () => {
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(signedManifest))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address()
    assert.ok(addr && typeof addr === 'object')
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    )
  })

  it('resolves the manifest when the record payee matches the manifest payee', async () => {
    const registry = new ProviderRegistry({
      onChain: { horizonUrl: 'https://horizon-testnet.stellar.org', knownAccounts: [] },
    })
    const manifest = await registry.fetchProviderManifest(recordFor(baseUrl, payeeKeypair.publicKey()))
    assert.equal(manifest.payee, payeeKeypair.publicKey())
  })

  it('throws RouteDockSignatureError when the record payee differs from the manifest payee', async () => {
    const registry = new ProviderRegistry({
      onChain: { horizonUrl: 'https://horizon-testnet.stellar.org', knownAccounts: [] },
    })
    // Record claims the attacker's account, but the served manifest is signed by
    // the attacker — the registry must refuse to bind them together.
    const record = recordFor(baseUrl, attackerKeypair.publicKey())
    await assert.rejects(
      () => registry.fetchProviderManifest(record),
      (err: unknown) =>
        err instanceof RouteDockSignatureError &&
        err.message.includes('does not match expected payee'),
    )
  })
})

describe('ProviderRegistry.searchProviders', () => {
  const horizonUrl = 'https://horizon-testnet.stellar.org'

  const row = {
    id: '1',
    name: 'Stellar DEX Price Feed',
    description: 'Streaming price feed',
    base_url: 'https://feed.example.com',
    modes: ['mpp-session'],
    tags: ['price', 'dex'],
    network: 'testnet',
    payee: payeeKeypair.publicKey(),
    manifest: {},
    verified: true,
    registered_at: '2026-01-01T00:00:00Z',
  }

  function fakeSupabase(
    rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>,
  ): SupabaseClient {
    return { rpc } as unknown as SupabaseClient
  }

  function withOnChain(registry: ProviderRegistry, providers: unknown[]): void {
    ;(registry as unknown as { onChain: { listProviders: () => Promise<unknown[]> } }).onChain = {
      listProviders: async () => providers,
    }
  }

  it('maps rpc rows and passes the query, network and limit through', async () => {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = []
    const registry = new ProviderRegistry({
      supabase: fakeSupabase(async (fn, args) => {
        calls.push({ fn, args })
        return { data: [row], error: null }
      }),
      onChain: { horizonUrl, knownAccounts: [] },
    })

    const results = await registry.searchProviders('  streaming price feed ', { limit: 5 })

    assert.deepEqual(calls, [
      {
        fn: 'search_providers',
        args: { query: 'streaming price feed', network: 'testnet', verified_only: true, max_results: 5 },
      },
    ])
    assert.equal(results.length, 1)
    assert.equal(results[0]?.name, 'Stellar DEX Price Feed')
    assert.equal(results[0]?.source, 'supabase')
    assert.equal(results[0]?.verified, true)
  })

  it('uses the mainnet network and unverified rows when asked', async () => {
    let seen: Record<string, unknown> | undefined
    const registry = new ProviderRegistry({
      supabase: fakeSupabase(async (_fn, args) => {
        seen = args
        return { data: [], error: null }
      }),
      onChain: { horizonUrl: 'https://horizon.stellar.org', knownAccounts: [] },
    })

    await registry.searchProviders('price', { includeUnverified: true })

    assert.equal(seen?.['network'], 'mainnet')
    assert.equal(seen?.['verified_only'], false)
    assert.equal(seen?.['max_results'], 20)
  })

  it('returns an empty list, without falling back, when the rpc finds nothing', async () => {
    const registry = new ProviderRegistry({
      supabase: fakeSupabase(async () => ({ data: [], error: null })),
      onChain: { horizonUrl, knownAccounts: [] },
    })
    withOnChain(registry, [
      { account: payeeKeypair.publicKey(), endpoint: 'https://feed.example.com', tags: ['price'] },
    ])

    assert.deepEqual(await registry.searchProviders('price'), [])
  })

  it('falls back to the on-chain registry when the rpc errors', async () => {
    const registry = new ProviderRegistry({
      supabase: fakeSupabase(async () => ({ data: null, error: { message: 'function does not exist' } })),
      onChain: { horizonUrl, knownAccounts: [] },
    })
    withOnChain(registry, [
      { account: payeeKeypair.publicKey(), endpoint: 'https://feed.example.com', tags: ['price', 'dex'] },
      { account: attackerKeypair.publicKey(), endpoint: 'https://other.example.com', tags: ['weather'] },
    ])

    const results = await registry.searchProviders('Streaming PRICE feed')

    assert.equal(results.length, 1)
    assert.equal(results[0]?.source, 'onchain')
    assert.equal(results[0]?.payee, payeeKeypair.publicKey())
  })

  it('falls back to the on-chain registry when the rpc throws or Supabase is not configured', async () => {
    const onChainProviders = [
      { account: payeeKeypair.publicKey(), endpoint: 'https://feed.example.com/stream', tags: [] },
    ]

    const throwing = new ProviderRegistry({
      supabase: fakeSupabase(async () => {
        throw new Error('network down')
      }),
      onChain: { horizonUrl, knownAccounts: [] },
    })
    withOnChain(throwing, onChainProviders)
    assert.equal((await throwing.searchProviders('feed.example.com')).length, 1)

    const unconfigured = new ProviderRegistry({ onChain: { horizonUrl, knownAccounts: [] } })
    withOnChain(unconfigured, onChainProviders)
    assert.equal((await unconfigured.searchProviders('feed.example.com/stream')).length, 1)
  })

  it('returns nothing for a blank query without calling the rpc', async () => {
    let called = false
    const registry = new ProviderRegistry({
      supabase: fakeSupabase(async () => {
        called = true
        return { data: [row], error: null }
      }),
      onChain: { horizonUrl, knownAccounts: [] },
    })

    assert.deepEqual(await registry.searchProviders('   '), [])
    assert.equal(called, false)
  })
})
