import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Store } from '@stellar/mpp/channel/server'
import {
  isVoucherStoreValue,
  type ChannelStore,
} from '../MppSessionHandler.js'

describe('isVoucherStoreValue type guard', () => {
  it('returns true for objects with valid numeric string amounts', () => {
    assert.equal(isVoucherStoreValue({ amount: '10000000' }), true)
    assert.equal(isVoucherStoreValue({ amount: '0' }), true)
    assert.equal(isVoucherStoreValue({ amount: '12345678901234567890' }), true)
    assert.equal(
      isVoucherStoreValue({ amount: '5000000', signature: 'abcdef' }),
      true,
    )
  })

  it('returns false for non-numeric or malformed amount strings', () => {
    assert.equal(isVoucherStoreValue({ amount: 'invalid' }), false)
    assert.equal(isVoucherStoreValue({ amount: '10.5' }), false)
    assert.equal(isVoucherStoreValue({ amount: '-500' }), false)
    assert.equal(isVoucherStoreValue({ amount: '0x10' }), false)
    assert.equal(isVoucherStoreValue({ amount: '' }), false)
  })

  it('returns false when amount is missing or not a string', () => {
    assert.equal(isVoucherStoreValue({ amount: 100 }), false)
    assert.equal(isVoucherStoreValue({ amount: null }), false)
    assert.equal(isVoucherStoreValue({ amount: undefined }), false)
    assert.equal(isVoucherStoreValue({ amount: {} }), false)
    assert.equal(isVoucherStoreValue({ otherKey: '100' }), false)
  })

  it('returns false for non-object and null values', () => {
    assert.equal(isVoucherStoreValue(null), false)
    assert.equal(isVoucherStoreValue(undefined), false)
    assert.equal(isVoucherStoreValue('string'), false)
    assert.equal(isVoucherStoreValue(123), false)
    assert.equal(isVoucherStoreValue(true), false)
  })
})

describe('ChannelStore update capability check', () => {
  it('delegates to update when innerStore supports update', async () => {
    const innerStore = Store.memory()
    let updateCalled = false

    const wrappedStore: ChannelStore = {
      async get(key: string) {
        return innerStore.get(key)
      },
      async put(key: string, value: unknown) {
        await innerStore.put(key, value)
      },
      async delete(key: string) {
        return innerStore.delete(key)
      },
      async update(key: string, fn: (prev: unknown) => unknown) {
        const storeWithUpdate = innerStore as Partial<ChannelStore>
        if (typeof storeWithUpdate.update === 'function') {
          updateCalled = true
          return storeWithUpdate.update(key, fn)
        }
        throw new Error('Store does not support atomic update operations')
      },
    }

    await wrappedStore.put('test-key', { amount: '100' })
    await wrappedStore.update!('test-key', (prev: unknown) => ({
      op: 'noop',
      result: prev,
    }))

    assert.equal(updateCalled, true)
  })

  it('throws expected error when innerStore lacks update capability', async () => {
    const basicStore = {
      async get() {
        return null
      },
      async put() {},
      async delete() {},
    }

    const wrappedStore: ChannelStore = {
      async get(key: string) {
        return basicStore.get()
      },
      async put(key: string, value: unknown) {
        await basicStore.put()
      },
      async delete(key: string) {
        return basicStore.delete()
      },
      async update(key: string, fn: (prev: unknown) => unknown) {
        const storeWithUpdate = basicStore as Partial<ChannelStore>
        if (typeof storeWithUpdate.update === 'function') {
          return storeWithUpdate.update(key, fn)
        }
        throw new Error('Store does not support atomic update operations')
      },
    }

    await assert.rejects(
      async () => {
        await wrappedStore.update!('key', (prev: unknown) => ({
          op: 'noop',
          result: prev,
        }))
      },
      {
        name: 'Error',
        message: 'Store does not support atomic update operations',
      },
    )
  })
})
