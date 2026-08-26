import assert from 'node:assert/strict'
import test from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import { Errors } from 'mppx'
import {
  channelAuthorizer,
  formatMppError,
  withTypedChannelErrors,
} from '../mppCompatibility.js'

const keypair = Keypair.random()

function failingMethod(message: string, details?: Record<string, unknown>) {
  return {
    name: 'stellar',
    intent: 'channel',
    verify: async () => {
      const error = new Error(message) as Error & { details?: Record<string, unknown> }
      if (details) error.details = details
      throw error
    },
  }
}

test('channelAuthorizer identifies the envelope signer explicitly', () => {
  assert.deepEqual(channelAuthorizer(keypair), { envelopeSigner: keypair })
})

test('formatMppError preserves structured SDK failures', () => {
  assert.equal(
    formatMppError({ code: 'scecInvalidAction', status: 'FAILED' }),
    '{"code":"scecInvalidAction","status":"FAILED"}',
  )
})

test('withTypedChannelErrors preserves invalid-signature errors', async () => {
  const method = withTypedChannelErrors(failingMethod('Commitment signature verification failed.'))
  await assert.rejects(method.verify as () => Promise<unknown>, (error) => {
    return error instanceof Errors.InvalidSignatureError
  })
})

test('withTypedChannelErrors preserves signer-mismatch errors', async () => {
  const method = withTypedChannelErrors(failingMethod('Transaction authorizer does not match recipient.'))
  await assert.rejects(method.verify as () => Promise<unknown>, (error) => {
    return error instanceof Errors.SignerMismatchError
  })
})

test('withTypedChannelErrors preserves replay errors as invalid challenges', async () => {
  const method = withTypedChannelErrors(failingMethod('Challenge already used. Replay rejected.'))
  await assert.rejects(method.verify as () => Promise<unknown>, (error) => {
    return error instanceof Errors.InvalidChallengeError
  })
})

test('withTypedChannelErrors maps cumulative validation errors', async () => {
  const method = withTypedChannelErrors(
    failingMethod('Commitment amount 10 must be greater than previous cumulative 10.', {
      commitmentAmount: '10',
      previousCumulative: '10',
    }),
  )
  await assert.rejects(method.verify as () => Promise<unknown>, (error) => {
    return error instanceof Errors.DeltaTooSmallError && error.message.includes('previousCumulative')
  })
})
