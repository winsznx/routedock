import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { blake2b } from '../nano/blake2b.js'
import {
  isNanoAddress,
  nanoAddressFromPublicKey,
  nanoPublicKey,
  normalizeNanoAddress,
} from '../nano/address.js'

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const fromHex = (h: string): Uint8Array => Uint8Array.from(h.match(/../g) ?? [], (x) => parseInt(x, 16))

const GENESIS_KEY = 'E89208DD038FBB269987689621D52292AE9C35941A7484756ECCED92A65093BA'
const GENESIS = 'nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3'
const BURN = 'nano_1111111111111111111111111111111111111111111111111111hifc8npp'

describe('blake2b', () => {
  it('matches the RFC 7693 vector for "abc"', () => {
    // #given / #when
    const digest = blake2b(new TextEncoder().encode('abc'), 64)
    // #then
    assert.equal(
      hex(digest),
      'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923',
    )
  })

  it('handles an empty input, an exact block and several blocks', () => {
    // #given
    const block = Uint8Array.from({ length: 128 }, (_, i) => i)
    const twoBlocks = Uint8Array.from({ length: 256 }, (_, i) => i)
    // #when / #then (expected values from Python's hashlib.blake2b)
    assert.equal(hex(blake2b(new Uint8Array(0), 32)), '0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8')
    assert.equal(hex(blake2b(block, 16)), 'a74787004ef589e31149183900d0294a')
    assert.equal(hex(blake2b(twoBlocks, 32)), '39a7eb9fedc19aabc83425c6755dd90e6f9d0c804964a1f4aaeea3b9fb599835')
  })
})

describe('nano addresses', () => {
  it('encodes a public key with its checksum', () => {
    assert.equal(nanoAddressFromPublicKey(new Uint8Array(32)), BURN)
    assert.equal(nanoAddressFromPublicKey(fromHex(GENESIS_KEY)), GENESIS)
  })

  it('decodes a valid address back to its public key', () => {
    const key = nanoPublicKey(GENESIS)
    assert.ok(key)
    assert.equal(hex(key).toUpperCase(), GENESIS_KEY)
  })

  it('refuses an address whose checksum does not match', () => {
    // #given one checksum character changed
    const broken = `${GENESIS.slice(0, -1)}1`
    // #then
    assert.equal(isNanoAddress(broken), false)
    assert.equal(nanoPublicKey(broken), null)
  })

  it('refuses a changed key character even with the original checksum', () => {
    // #given one character of the key part changed, checksum left as it was
    const broken = GENESIS.replace('95xu', '95xw')
    // #then
    assert.notEqual(broken, GENESIS)
    assert.equal(isNanoAddress(broken), false)
  })

  it('refuses wrong prefixes, lengths and characters', () => {
    assert.equal(isNanoAddress(GENESIS.replace('nano_', 'ban_')), false)
    assert.equal(isNanoAddress(GENESIS.slice(0, -2)), false)
    assert.equal(isNanoAddress(GENESIS.replace('3t6k', '3t6l')), false)
    assert.equal(isNanoAddress(GENESIS.toUpperCase()), false)
  })

  it('normalises the legacy xrb_ prefix to nano_', () => {
    assert.equal(normalizeNanoAddress(GENESIS.replace('nano_', 'xrb_')), GENESIS)
  })
})
