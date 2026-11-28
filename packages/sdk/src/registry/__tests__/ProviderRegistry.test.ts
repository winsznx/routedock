/**
 * Tests for ProviderRegistry network derivation and the manifest↔payee
 * cross-check that closes the self-signed trust gap (issue #146).
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { createServer } from 'node:http'
import { Keypair } from '@stellar/stellar-sdk'
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
  it('maps the two public Horizon hosts', () => {
    assert.equal(deriveNetwork('https://horizon-testnet.stellar.org'), 'testnet')
    assert.equal(deriveNetwork('https://horizon.stellar.org'), 'mainnet')
    assert.equal(deriveNetwork('https://horizon.stellar.org/'), 'mainnet')
  })

  it('throws for any other Horizon URL instead of defaulting to mainnet', () => {
    for (const url of [
      'https://example.com/unknown',
      'http://localhost:8000',
      'https://horizon-futurenet.stellar.org',
      'https://my-testnet-proxy.example.com',
    ]) {
      assert.throws(() => deriveNetwork(url), /Pass onChain\.network/, url)
    }
  })
})

describe('ProviderRegistry — network configuration', () => {
  it('throws without an explicit network on a non-public Horizon URL', () => {
    assert.throws(
      () => new ProviderRegistry({ onChain: { horizonUrl: 'http://localhost:8000', knownAccounts: [] } }),
      /Cannot derive the Stellar network/,
    )
  })

  it('accepts a local Horizon URL when the network is passed', () => {
    assert.doesNotThrow(
      () =>
        new ProviderRegistry({
          onChain: { horizonUrl: 'http://localhost:8000', knownAccounts: [], network: 'testnet' },
        }),
    )
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
