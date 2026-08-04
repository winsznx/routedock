import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  InMemorySeenTxStore,
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

describe('paymentIdempotencyKey', () => {
  const key = async (h: Record<string, string>) =>
    await paymentIdempotencyKey((name) => h[name])

  it('returns null when no payment header is present', async () => {
    assert.equal(await key({ 'content-type': 'application/json' }), null)
  })

  it('keys off payment-signature when present', async () => {
    const result = await key({ 'payment-signature': 'sig' })
    assert.ok(result)
    assert.equal(result!.length, 64)
  })

  it('prefers payment-signature over x-payment and authorization', async () => {
    const result = await key({
      'payment-signature': 'sig',
      'x-payment': 'xp',
      authorization: 'Payment a',
    })
    const sigResult = await key({ 'payment-signature': 'sig' })
    assert.equal(result, sigResult)
  })

  it('falls back to authorization for mpp credentials', async () => {
    const authKey = await key({ authorization: 'Payment credential="abc"' })
    assert.ok(authKey)
    assert.equal(authKey!.length, 64)
  })

  it('yields the same key for a byte-identical retry', async () => {
    const headers = { 'x-payment': 'identical-signed-payment' }
    assert.equal(await key(headers), await key(headers))
  })
})
