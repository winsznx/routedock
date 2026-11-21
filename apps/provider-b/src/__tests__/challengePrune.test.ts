import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { pruneStaleChallenges, CHALLENGE_PREFIX } from '../challengePrune.js'

function fakeStorage(initial: Record<string, unknown>) {
  const data = new Map(Object.entries(initial))
  return {
    data,
    async list({ prefix }: { prefix: string }) {
      return new Map([...data].filter(([k]) => k.startsWith(prefix)))
    },
    async delete(keys: string[]) {
      let n = 0
      for (const k of keys) if (data.delete(k)) n++
      return n
    },
  }
}

describe('pruneStaleChallenges', () => {
  const now = Date.parse('2026-01-01T01:00:00Z')
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString()

  it('removes stale challenge keys and keeps in-window, voucher and cumulative keys', async () => {
    const storage = fakeStorage({
      [`${CHALLENGE_PREFIX}old1`]: { usedAt: iso(11 * 60_000) },
      [`${CHALLENGE_PREFIX}old2`]: { usedAt: iso(60 * 60_000) },
      [`${CHALLENGE_PREFIX}fresh`]: { usedAt: iso(60_000) },
      'stellar:channel:cumulative:CABC': { amount: '5' },
      'routedock:session:voucher:CABC': { amount: '5' },
    })
    const deleted = await pruneStaleChallenges(storage, now)
    assert.equal(deleted, 2)
    assert.deepEqual([...storage.data.keys()].sort(), [
      'routedock:session:voucher:CABC',
      `${CHALLENGE_PREFIX}fresh`,
      'stellar:channel:cumulative:CABC',
    ])
  })

  it('batches deletes of more than 128 keys', async () => {
    const init: Record<string, unknown> = {}
    for (let i = 0; i < 300; i++) init[`${CHALLENGE_PREFIX}${i}`] = { usedAt: iso(3_600_000) }
    const storage = fakeStorage(init)
    assert.equal(await pruneStaleChallenges(storage, now), 300)
    assert.equal(storage.data.size, 0)
  })
})
