import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Store } from 'mppx'
import {
  createChallengeRetention,
  CHALLENGE_KEY_PREFIX,
} from '../challengeRetention.js'

describe('createChallengeRetention', () => {
  it('leaves only in-window challenge keys and never prunes other keys (10,000 vouchers)', async () => {
    const store = Store.memory()
    let clock = 0
    const retention = createChallengeRetention({ now: () => clock })
    await store.put('stellar:channel:cumulative:C1', { amount: '1' })
    await store.put('routedock:session:voucher:C1', { amount: '1' })
    const put = async (k: string, v: unknown) => {
      await store.put(k, v as never)
      await retention.afterPut(k, (x) => store.delete(x))
    }
    for (let i = 0; i < 10_000; i++) {
      clock = i * 1000 // one voucher per second, ~2.8 hours
      await put(`${CHALLENGE_KEY_PREFIX}${i}`, { usedAt: new Date(clock).toISOString() })
    }
    // retention is 10 min: keys 9400..9999 (601 keys, inclusive boundary) remain
    assert.ok(retention.size() <= 601)
    assert.equal(await store.get(`${CHALLENGE_KEY_PREFIX}0`), null)
    assert.equal(await store.get(`${CHALLENGE_KEY_PREFIX}9999`) !== null, true)
    assert.equal(await store.get(`${CHALLENGE_KEY_PREFIX}9500`) !== null, true)
    assert.equal(await store.get('stellar:channel:cumulative:C1') !== null, true)
    assert.equal(await store.get('routedock:session:voucher:C1') !== null, true)
  })

  it('keeps a key tracked and does not throw when delete fails', async () => {
    let clock = 0
    const errors: string[] = []
    const retention = createChallengeRetention({
      now: () => clock,
      challengeRetentionMs: 1000,
      onError: (_e, k) => errors.push(k),
    })
    await retention.afterPut(`${CHALLENGE_KEY_PREFIX}a`, async () => {})
    clock = 5000
    await retention.afterPut(`${CHALLENGE_KEY_PREFIX}b`, async () => {
      throw new Error('boom')
    })
    assert.deepEqual(errors, [`${CHALLENGE_KEY_PREFIX}a`])
    assert.equal(retention.size(), 2)
  })

  it('ignores non-challenge keys', async () => {
    const retention = createChallengeRetention()
    await retention.afterPut('routedock:session:voucher:C1', async () => {})
    assert.equal(retention.size(), 0)
  })
})
