/**
 * BLAKE2b (RFC 7693), unkeyed, variable output length.
 *
 * Nano needs it for one thing: the 5-byte checksum at the end of every
 * `nano_` address. Inputs are 32 bytes, so a BigInt implementation is fast
 * enough and keeps this module free of dependencies (it runs unchanged on
 * Node and on Workers).
 */

const MASK = (1n << 64n) - 1n

const IV: readonly bigint[] = [
  0x6a09e667f3bcc908n,
  0xbb67ae8584caa73bn,
  0x3c6ef372fe94f82bn,
  0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n,
  0x9b05688c2b3e6c1fn,
  0x1f83d9abfb41bd6bn,
  0x5be0cd19137e2179n,
]

const SIGMA: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
]

function rotr(x: bigint, n: bigint): bigint {
  return ((x >> n) | (x << (64n - n))) & MASK
}

function word(v: bigint[], i: number): bigint {
  const w = v[i]
  if (w === undefined) throw new RangeError(`blake2b: no word at ${i}`)
  return w
}

function mix(v: bigint[], a: number, b: number, c: number, d: number, x: bigint, y: bigint): void {
  v[a] = (word(v, a) + word(v, b) + x) & MASK
  v[d] = rotr(word(v, d) ^ word(v, a), 32n)
  v[c] = (word(v, c) + word(v, d)) & MASK
  v[b] = rotr(word(v, b) ^ word(v, c), 24n)
  v[a] = (word(v, a) + word(v, b) + y) & MASK
  v[d] = rotr(word(v, d) ^ word(v, a), 16n)
  v[c] = (word(v, c) + word(v, d)) & MASK
  v[b] = rotr(word(v, b) ^ word(v, c), 63n)
}

function compress(h: bigint[], block: Uint8Array, t: bigint, last: boolean): void {
  const m: bigint[] = []
  for (let i = 0; i < 16; i++) {
    let w = 0n
    for (let j = 7; j >= 0; j--) w = (w << 8n) | BigInt(block[i * 8 + j] ?? 0)
    m.push(w)
  }
  const v = [...h, ...IV]
  v[12] = word(v, 12) ^ (t & MASK)
  v[13] = word(v, 13) ^ (t >> 64n)
  if (last) v[14] = word(v, 14) ^ MASK
  for (let r = 0; r < 12; r++) {
    const s = SIGMA[r % 10]
    if (s === undefined) throw new RangeError('blake2b: bad round')
    const x = (i: number): bigint => word(m, s[i] ?? 0)
    mix(v, 0, 4, 8, 12, x(0), x(1))
    mix(v, 1, 5, 9, 13, x(2), x(3))
    mix(v, 2, 6, 10, 14, x(4), x(5))
    mix(v, 3, 7, 11, 15, x(6), x(7))
    mix(v, 0, 5, 10, 15, x(8), x(9))
    mix(v, 1, 6, 11, 12, x(10), x(11))
    mix(v, 2, 7, 8, 13, x(12), x(13))
    mix(v, 3, 4, 9, 14, x(14), x(15))
  }
  for (let i = 0; i < 8; i++) h[i] = word(h, i) ^ word(v, i) ^ word(v, i + 8)
}

/** BLAKE2b digest of `input`, `outLen` bytes long (1..64). */
export function blake2b(input: Uint8Array, outLen: number): Uint8Array {
  if (!Number.isInteger(outLen) || outLen < 1 || outLen > 64) {
    throw new RangeError('blake2b: outLen must be 1..64')
  }
  const h = [...IV]
  h[0] = word(h, 0) ^ (0x01010000n | BigInt(outLen))

  let t = 0n
  let offset = 0
  // Every block but the last is compressed as non-final; an empty input is one empty final block.
  while (input.length - offset > 128) {
    t += 128n
    compress(h, input.subarray(offset, offset + 128), t, false)
    offset += 128
  }
  const tail = new Uint8Array(128)
  tail.set(input.subarray(offset))
  t += BigInt(input.length - offset)
  compress(h, tail, t, true)

  const out = new Uint8Array(outLen)
  for (let i = 0; i < outLen; i++) {
    out[i] = Number((word(h, i >> 3) >> (8n * BigInt(i & 7))) & 0xffn)
  }
  return out
}
