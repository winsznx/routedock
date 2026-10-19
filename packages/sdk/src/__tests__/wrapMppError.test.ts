import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  wrapMppError,
  RouteDockError,
  RouteDockNetworkError,
  RouteDockSignatureError,
  RouteDockManifestError,
} from '../errors.js'

describe('wrapMppError', () => {
  it('passes through an error that is already a RouteDockError unchanged', () => {
    const original = new RouteDockManifestError('manifest error')
    const wrapped = wrapMppError(original, 'test-context')
    assert.strictEqual(wrapped, original)
  })

  it('wraps TypeError as RouteDockNetworkError (retryable: true)', () => {
    const err = new TypeError('fetch failed')
    const wrapped = wrapMppError(err, 'MPP charge request')
    assert.ok(wrapped instanceof RouteDockNetworkError)
    assert.equal(wrapped.code, 'NETWORK')
    assert.equal(wrapped.retryable, true)
    assert.equal(wrapped.cause, err)
    assert.ok(wrapped.message.includes('MPP charge request: TypeError: fetch failed'))
  })

  it('wraps AbortError as RouteDockNetworkError (retryable: true)', () => {
    const err = new Error('request aborted')
    err.name = 'AbortError'
    const wrapped = wrapMppError(err, 'Voucher request')
    assert.ok(wrapped instanceof RouteDockNetworkError)
    assert.equal(wrapped.code, 'NETWORK')
    assert.equal(wrapped.retryable, true)
    assert.equal(wrapped.cause, err)
  })

  it('wraps TimeoutError as RouteDockNetworkError (retryable: true)', () => {
    const err = new Error('request timed out')
    err.name = 'TimeoutError'
    const wrapped = wrapMppError(err, 'Voucher request')
    assert.ok(wrapped instanceof RouteDockNetworkError)
    assert.equal(wrapped.code, 'NETWORK')
    assert.equal(wrapped.retryable, true)
    assert.equal(wrapped.cause, err)
  })

  it('wraps signing / challenge parsing errors as RouteDockSignatureError (retryable: false)', () => {
    const err = new Error('bad challenge')
    const wrapped = wrapMppError(err, 'MPP charge request')
    assert.ok(wrapped instanceof RouteDockSignatureError)
    assert.equal(wrapped.code, 'SIGNATURE')
    assert.equal(wrapped.retryable, false)
    assert.equal(wrapped.cause, err)
    assert.ok(wrapped.message.includes('MPP charge request: Error: bad challenge'))
  })
})
