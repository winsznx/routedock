/**
 * Synchronous, runtime-neutral SHA-2 helpers (pure JS via `@noble/hashes`).
 *
 * `node:crypto` is unavailable on Workers without `nodejs_compat` and in
 * browsers, and WebCrypto is async-only, which would force every caller of the
 * synchronous manifest-signing API to change. Output is byte-identical to
 * `createHash('sha256' | 'sha512')`.
 */
import { sha256 as nobleSha256, sha512 as nobleSha512 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from './encoding.js'

export function sha256(data: Uint8Array | string): Uint8Array {
  return nobleSha256(typeof data === 'string' ? utf8ToBytes(data) : data)
}

export function sha256Hex(data: Uint8Array | string): string {
  return bytesToHex(sha256(data))
}

export function sha512(data: Uint8Array | string): Uint8Array {
  return nobleSha512(typeof data === 'string' ? utf8ToBytes(data) : data)
}
