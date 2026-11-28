import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Account, Keypair } from '@stellar/stellar-sdk'
import {
  MAX_DATA_ENTRY_BYTES,
  buildRegistrationTransaction,
  buildRegistryEntries,
  registerOnChain,
} from '../registerOnChain.js'

describe('buildRegistryEntries', () => {
  it('accepts an endpoint of exactly 64 bytes', () => {
    const endpoint = `https://${'a'.repeat(MAX_DATA_ENTRY_BYTES - 'https://'.length)}`
    assert.equal(new TextEncoder().encode(endpoint).length, 64)
    assert.equal(buildRegistryEntries(endpoint).routedock_endpoint, endpoint)
  })

  it('refuses an endpoint longer than 64 bytes', () => {
    const endpoint = `https://${'a'.repeat(MAX_DATA_ENTRY_BYTES)}`
    assert.throws(() => buildRegistryEntries(endpoint), /over the 64-byte limit/)
  })

  it('counts bytes, not characters', () => {
    // 40 two-byte characters = 80 bytes but only 48 chars with the scheme.
    assert.throws(() => buildRegistryEntries(`https://${'é'.repeat(40)}.io`), /over the 64-byte limit/)
  })

  it('refuses a non-http(s) endpoint', () => {
    assert.throws(() => buildRegistryEntries('ftp://x.example.com'), /http\(s\) URL/)
  })

  it('encodes tags as a JSON array and refuses oversized or empty ones', () => {
    assert.equal(buildRegistryEntries('https://a.io', ['ai', 'dex']).routedock_tags, '["ai","dex"]')
    assert.equal(buildRegistryEntries('https://a.io').routedock_tags, undefined)
    assert.throws(() => buildRegistryEntries('https://a.io', ['x'.repeat(70)]), /tags encode to/)
    assert.throws(() => buildRegistryEntries('https://a.io', ['ok', '']), /non-empty strings/)
  })
})

describe('buildRegistrationTransaction', () => {
  const keypair = Keypair.random()
  const source = () => new Account(keypair.publicKey(), '1')

  it('writes the endpoint and tags data entries and signs the transaction', () => {
    const tx = buildRegistrationTransaction(keypair, source(), {
      endpoint: 'https://api.example.com',
      tags: ['ai'],
      network: 'testnet',
    })
    assert.equal(tx.operations.length, 2)
    const [endpointOp, tagsOp] = tx.operations as unknown as Array<{ name: string; value: Buffer | null }>
    assert.equal(endpointOp!.name, 'routedock_endpoint')
    assert.equal(endpointOp!.value?.toString('utf-8'), 'https://api.example.com')
    assert.equal(tagsOp!.name, 'routedock_tags')
    assert.equal(tagsOp!.value?.toString('utf-8'), '["ai"]')
    assert.equal(tx.signatures.length, 1)
  })

  it('clears the tags entry when none are given', () => {
    const tx = buildRegistrationTransaction(keypair, source(), {
      endpoint: 'https://api.example.com',
      network: 'testnet',
    })
    const tagsOp = tx.operations[1] as unknown as { name: string; value: Buffer | null }
    assert.equal(tagsOp.name, 'routedock_tags')
    assert.equal(tagsOp.value, null)
  })

  it('throws before building anything for an oversized endpoint', () => {
    assert.throws(
      () =>
        buildRegistrationTransaction(keypair, source(), {
          endpoint: `https://${'a'.repeat(80)}`,
          network: 'testnet',
        }),
      /over the 64-byte limit/,
    )
  })
})

describe('registerOnChain', () => {
  it('rejects an oversized endpoint without touching the network', async () => {
    await assert.rejects(
      registerOnChain({
        secret: Keypair.random().secret(),
        endpoint: `https://${'a'.repeat(80)}`,
        network: 'testnet',
        horizonUrl: 'http://127.0.0.1:1', // would fail to connect if it were reached
      }),
      /over the 64-byte limit/,
    )
  })
})
