import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Challenge, Credential } from 'mppx'
import { Keypair } from '@stellar/stellar-sdk'
import { parseMppCredential } from '../credential.js'

describe('parseMppCredential', () => {
  it('returns payload.signature and payload.amount for a channel voucher header built with Credential.serialize', () => {
    const challenge = Challenge.from({
      id: 'c1',
      realm: 'routedock',
      method: 'stellar',
      intent: 'channel',
      request: { amount: '1' },
    })
    const sig = 'ab'.repeat(64)
    const header = Credential.serialize(
      Credential.from({
        challenge,
        payload: { action: 'voucher', amount: '1000', signature: sig },
      }),
    )

    const parsed = parseMppCredential(header)
    assert.ok(parsed)
    assert.equal(parsed.payload?.amount, '1000')
    assert.equal(parsed.payload?.signature, sig)
  })

  it('returns source for a charge header built with Credential.serialize', () => {
    const payer = Keypair.random().publicKey()
    const source = `did:pkh:stellar:testnet:${payer}`
    const challenge = Challenge.from({
      id: 'c2',
      realm: 'routedock',
      method: 'stellar',
      intent: 'charge',
      request: { amount: '8000' },
    })
    const header = Credential.serialize(
      Credential.from({
        challenge,
        payload: { type: 'transaction', transaction: 'AAAA...' },
        source,
      }),
    )

    const parsed = parseMppCredential(header)
    assert.ok(parsed)
    assert.equal(parsed.source, source)
  })

  it('returns null for undefined, Bearer x, and Payment not-base64!!', () => {
    assert.equal(parseMppCredential(undefined), null)
    assert.equal(parseMppCredential('Bearer x'), null)
    assert.equal(parseMppCredential('Payment not-base64!!'), null)
  })

  it('decodes a serialized credential whose base64url token contains - and _', () => {
    // Include characters whose UTF-8 byte sequences (e.g. >\xfb\xff or similar)
    // produce '-' (62) and '_' (63) in base64url encoding.
    const challenge = Challenge.from({
      id: 'c3->>>???',
      realm: 'routedock/test?a=1&b=2~3',
      method: 'stellar',
      intent: 'channel',
      request: { amount: '100', note: '>>>???~~~' },
    })
    const sig = 'fe'.repeat(64)
    const header = Credential.serialize(
      Credential.from({
        challenge,
        payload: {
          action: 'voucher',
          amount: '500',
          signature: sig,
          marker: '>>>???\u00fb\u00ff',
        },
      }),
    )

    const token = header.replace(/^Payment\s+/, '')
    assert.ok(
      token.includes('-') || token.includes('_'),
      `expected base64url token to contain '-' or '_', got: ${token}`,
    )

    const parsed = parseMppCredential(header)
    assert.ok(parsed)
    assert.equal(parsed.payload?.amount, '500')
    assert.equal(parsed.payload?.signature, sig)
  })
})
