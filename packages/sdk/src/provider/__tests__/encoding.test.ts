import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { base64ToUtf8, hexToBytes } from '../encoding.js'

describe('base64ToUtf8', () => {
  it('decodes ASCII base64 to text', () => {
    const b64 = Buffer.from('hello world', 'utf8').toString('base64')
    assert.equal(base64ToUtf8(b64), 'hello world')
  })

  it('preserves multi-byte UTF-8 (matches Buffer)', () => {
    const original = 'héllo, 世界 — 🚀'
    const b64 = Buffer.from(original, 'utf8').toString('base64')
    assert.equal(base64ToUtf8(b64), original)
  })

  it('round-trips a JSON receipt payload', () => {
    const payload = JSON.stringify({ reference: 'abc123', amount: '0.0008' })
    const b64 = Buffer.from(payload, 'utf8').toString('base64')
    assert.deepEqual(JSON.parse(base64ToUtf8(b64)), JSON.parse(payload))
  })
})

describe('hexToBytes', () => {
  it('decodes a hex string to bytes (matches Buffer)', () => {
    const hex = 'deadbeef00ff'
    assert.deepEqual([...hexToBytes(hex)], [...Buffer.from(hex, 'hex')])
  })

  it('accepts a 0x prefix', () => {
    assert.deepEqual([...hexToBytes('0xdeadbeef')], [0xde, 0xad, 0xbe, 0xef])
  })

  it('returns a Uint8Array', () => {
    assert.ok(hexToBytes('00') instanceof Uint8Array)
  })

  it('throws on odd-length input', () => {
    assert.throws(() => hexToBytes('abc'), /even length/)
  })

  it('round-trips a 64-byte ed25519-style signature', () => {
    const bytes = new Uint8Array(64).map((_, i) => i)
    const hex = Buffer.from(bytes).toString('hex')
    assert.deepEqual([...hexToBytes(hex)], [...bytes])
  })
})
