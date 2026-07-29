import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Keypair, StrKey } from '@stellar/stellar-sdk'
import { extractPayerAddress } from '../payer.js'

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
