import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  InMemorySeenTxStore,
  hashString,
  paymentIdempotencyKey,
} from '../SeenTxStore.js'

describe('InMemorySeenTxStore', () => {
  it('returns undefined for unseen keys', () => {
    const store = new InMemorySeenTxStore()
    assert.equal(store.get('nope'), undefined)
  })

  it('stores and returns a settlement record', () => {
    const store = new InMemorySeenTxStore()
    store.set('k1', { txHash: 'tx_abc', headers: { 'X-Payment-Response': 'r' } })
    assert.deepEqual(store.get('k1'), {
      txHash: 'tx_abc',
      headers: { 'X-Payment-Response': 'r' },
    })
  })

  it('evicts the oldest entry past maxEntries (FIFO)', () => {
    const store = new InMemorySeenTxStore(2)
    store.set('a', { txHash: 'a' })
    store.set('b', { txHash: 'b' })
    store.set('c', { txHash: 'c' }) // evicts 'a'
    assert.equal(store.get('a'), undefined)
    assert.deepEqual(store.get('b'), { txHash: 'b' })
    assert.deepEqual(store.get('c'), { txHash: 'c' })
  })

  it('overwriting a key does not grow the eviction queue', () => {
    const store = new InMemorySeenTxStore(2)
    store.set('a', { txHash: 'a1' })
    store.set('a', { txHash: 'a2' })
    store.set('b', { txHash: 'b' })
    // 'a' was overwritten, not re-queued, so it must survive.
    assert.deepEqual(store.get('a'), { txHash: 'a2' })
    assert.deepEqual(store.get('b'), { txHash: 'b' })
  })
})

describe('hashString', () => {
  it('is deterministic', () => {
    assert.equal(hashString('payment-header-xyz'), hashString('payment-header-xyz'))
  })

  it('differs for different inputs', () => {
    assert.notEqual(hashString('a'), hashString('b'))
  })

  it('returns 8 hex chars', () => {
    assert.match(hashString('anything'), /^[0-9a-f]{8}$/)
  })
})

describe('paymentIdempotencyKey', () => {
  const key = (h: Record<string, string>) =>
    paymentIdempotencyKey((name) => h[name])

  it('returns null when no payment header is present', () => {
    assert.equal(key({ 'content-type': 'application/json' }), null)
  })

  it('keys off payment-signature when present', () => {
    assert.equal(key({ 'payment-signature': 'sig' }), hashString('sig'))
  })

  it('prefers payment-signature over x-payment and authorization', () => {
    assert.equal(
      key({ 'payment-signature': 'sig', 'x-payment': 'xp', authorization: 'Payment a' }),
      hashString('sig'),
    )
  })

  it('falls back to authorization for mpp credentials', () => {
    assert.equal(key({ authorization: 'Payment credential="abc"' }), hashString('Payment credential="abc"'))
  })

  it('yields the same key for a byte-identical retry', () => {
    const headers = { 'x-payment': 'identical-signed-payment' }
    assert.equal(key(headers), key(headers))
  })
})
