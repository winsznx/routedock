import { blake2b } from './blake2b.js'

/**
 * Nano account addresses: `nano_` + 52 base32 characters of the 32-byte
 * public key + 8 characters of checksum (BLAKE2b-40 of the key, byte-reversed).
 * The legacy `xrb_` prefix is accepted on input and normalised to `nano_`.
 */

const ALPHABET = '13456789abcdefghijkmnopqrstuwxyz'
const ADDRESS_RE = /^(nano|xrb)_[13][13456789abcdefghijkmnopqrstuwxyz]{59}$/

function encode(value: bigint, chars: number): string {
  let out = ''
  for (let i = 0; i < chars; i++) {
    out = ALPHABET.charAt(Number(value & 31n)) + out
    value >>= 5n
  }
  return out
}

function decode(text: string): bigint {
  let value = 0n
  for (const ch of text) {
    const i = ALPHABET.indexOf(ch)
    if (i < 0) throw new RangeError(`not a nano base32 character: ${ch}`)
    value = (value << 5n) | BigInt(i)
  }
  return value
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n
  for (const b of bytes) value = (value << 8n) | BigInt(b)
  return value
}

/** Encode a 32-byte public key (or any 32-byte value) as a `nano_` address. */
export function nanoAddressFromPublicKey(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new RangeError('a nano public key is 32 bytes')
  const checksum = blake2b(publicKey, 5).reverse()
  return `nano_${encode(bytesToBigInt(publicKey), 52)}${encode(bytesToBigInt(checksum), 8)}`
}

/**
 * Return the 32-byte public key of a checksum-valid address, or `null` for
 * anything else (wrong prefix, length, alphabet or checksum).
 */
export function nanoPublicKey(address: string): Uint8Array | null {
  if (typeof address !== 'string' || !ADDRESS_RE.test(address)) return null
  const body = address.slice(address.indexOf('_') + 1)
  let key = decode(body.slice(0, 52))
  const publicKey = new Uint8Array(32)
  for (let i = 31; i >= 0; i--) {
    publicKey[i] = Number(key & 0xffn)
    key >>= 8n
  }
  const expected = blake2b(publicKey, 5).reverse()
  if (decode(body.slice(52)) !== bytesToBigInt(expected)) return null
  return publicKey
}

/** True only for a checksum-valid `nano_` / `xrb_` address. */
export function isNanoAddress(address: string): boolean {
  return nanoPublicKey(address) !== null
}

/** The canonical `nano_` form of a valid address, or `null`. */
export function normalizeNanoAddress(address: string): string | null {
  const publicKey = nanoPublicKey(address)
  return publicKey === null ? null : nanoAddressFromPublicKey(publicKey)
}
