import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Keypair, StrKey } from '@stellar/stellar-sdk'
import { extractPayerAddress, payerFromDidPkh } from '../payer.js'

describe('extractPayerAddress', () => {
  it('accepts classic ed25519 Stellar public keys', () => {
    const publicKey = Keypair.random().publicKey()
    assert.equal(extractPayerAddress(publicKey), publicKey)
  })

  it('accepts muxed Stellar account keys', () => {
    const muxedPayload = Buffer.alloc(40)
    Buffer.from(Keypair.random().rawPublicKey()).copy(muxedPayload, 0)
    muxedPayload.writeBigUInt64BE(42n, 32)

    const muxedKey = StrKey.encodeMed25519PublicKey(muxedPayload)
    assert.equal(extractPayerAddress(muxedKey), muxedKey)
  })

  it('rejects malformed payer strings without throwing', () => {
    assert.equal(extractPayerAddress('Gnot-a-real-stellar-key'), null)
    assert.equal(extractPayerAddress('Mnot-a-real-muxed-key'), null)
    assert.equal(extractPayerAddress(null), null)
  })
})

describe('payerFromDidPkh', () => {
  it('returns the G address from did:pkh:stellar:testnet:<valid G>', () => {
    const publicKey = Keypair.random().publicKey()
    assert.equal(payerFromDidPkh(`did:pkh:stellar:testnet:${publicKey}`), publicKey)
  })

  it('returns a valid M address from a did:pkh string', () => {
    const muxedPayload = Buffer.alloc(40)
    Buffer.from(Keypair.random().rawPublicKey()).copy(muxedPayload, 0)
    muxedPayload.writeBigUInt64BE(99n, 32)
    const muxedKey = StrKey.encodeMed25519PublicKey(muxedPayload)
    assert.equal(payerFromDidPkh(`did:pkh:stellar:pubnet:${muxedKey}`), muxedKey)
  })

  it('returns null for malformed DIDs, bare strings with no DID prefix, and non-strings', () => {
    const publicKey = Keypair.random().publicKey()
    assert.equal(payerFromDidPkh('did:pkh:stellar:testnet:Gnot-valid'), null)
    assert.equal(payerFromDidPkh(`did:pkh:${publicKey}`), null)
    assert.equal(payerFromDidPkh(`did:pkh::${publicKey}`), null)
    assert.equal(payerFromDidPkh(publicKey), null)
    assert.equal(payerFromDidPkh(''), null)
    assert.equal(payerFromDidPkh(undefined), null)
    assert.equal(payerFromDidPkh(null), null)
    assert.equal(payerFromDidPkh(42), null)
    assert.equal(payerFromDidPkh({}), null)
  })
})
