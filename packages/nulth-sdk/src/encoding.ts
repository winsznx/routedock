/**
 * Runtime-neutral codecs and hashing (no `Buffer`, no `node:crypto`), so this
 * package runs in browsers, Workers without `nodejs_compat`, Bun and Deno.
 * Mirrors `packages/sdk/src/internal/{encoding,hash}.ts`.
 */
import { sha256 as nobleSha256, sha512 as nobleSha512 } from '@noble/hashes/sha2.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function utf8ToBytes(text: string): Uint8Array {
  return encoder.encode(text)
}

export function bytesToUtf8(bytes: Uint8Array): string {
  return decoder.decode(bytes)
}

export function bytesToBase64(bytes: Uint8Array): string {
  const chunk = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/**
 * Decode base64 to bytes with the same leniency as Node's
 * `Buffer.from(x, 'base64')`: URL-safe characters are accepted, padding is
 * optional, characters outside the alphabet are skipped and decoding stops at
 * the first `=`. Keeping this behaviour makes the switch away from `Buffer`
 * a no-op for every existing caller.
 */
export function base64ToBytes(b64: string): Uint8Array {
  const end = b64.indexOf('=')
  let clean = (end === -1 ? b64 : b64.slice(0, end))
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .replace(/[^A-Za-z0-9+/]/g, '')
  // A single trailing sextet carries no full byte; Buffer drops it.
  if (clean.length % 4 === 1) clean = clean.slice(0, -1)
  const binary = atob(clean)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0')
  }
  return out
}

export function sha256Bytes(data: Uint8Array | string): Uint8Array {
  return nobleSha256(typeof data === 'string' ? utf8ToBytes(data) : data)
}

export function sha512Bytes(data: Uint8Array | string): Uint8Array {
  return nobleSha512(typeof data === 'string' ? utf8ToBytes(data) : data)
}
