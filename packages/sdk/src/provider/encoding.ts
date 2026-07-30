/**
 * Web-standard binary/text codecs that run in any JavaScript runtime —
 * Cloudflare Workers, Bun, Deno, browsers, and Node.js.
 *
 * The Node-only `Buffer` global is unavailable on edge runtimes without a
 * polyfill, so the Workers-safe entry points (e.g. `provider/hono`) must use
 * these helpers instead of `Buffer.from(...)`.
 */

/**
 * Decode a base64 string to its UTF-8 text. Uses `atob` + `TextDecoder`
 * (both Web-standard) so multi-byte UTF-8 is preserved correctly — `atob`
 * alone yields a binary (latin1) string and corrupts non-ASCII bytes.
 */
export function base64ToUtf8(b64: string): string {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new TextDecoder().decode(bytes)
}

/**
 * Decode a hex string to a `Uint8Array`. Accepts an optional `0x` prefix.
 * Mirrors `Buffer.from(hex, 'hex')` but returns a plain `Uint8Array` (which
 * `Buffer` already extends, so existing consumers are unaffected).
 */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith('0x') ? hex.slice(2) : hex
  if (clean.length % 2 !== 0) {
    throw new Error('hexToBytes: hex string must have an even length')
  }
  const bytes = new Uint8Array(clean.length / 2)
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}
