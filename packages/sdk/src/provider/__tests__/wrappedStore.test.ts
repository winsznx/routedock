import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isVoucherStoreValue } from '../MppSessionHandler.js'

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
