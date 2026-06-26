import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  InMemorySpendStore,
  type DailySpend,
  type SpendStore,
} from '../SpendStore.js'

describe('InMemorySpendStore', () => {
  it('returns null before anything is written', async () => {
    const store = new InMemorySpendStore({ warn: false })
    assert.equal(await store.read(), null)
  })

  it('round-trips a written accumulator', async () => {
    const store = new InMemorySpendStore({ warn: false })
    const state: DailySpend = { date: '2026-06-26', total: 0.5 }
    await store.write(state)
    assert.deepEqual(await store.read(), state)
  })

  it('does not alias internal state (defensive copy)', async () => {
    const store = new InMemorySpendStore({ warn: false })
    const state: DailySpend = { date: '2026-06-26', total: 0.5 }
    await store.write(state)

    // Mutating the caller's object must not affect stored state.
    state.total = 999
    const read = await store.read()
    assert.equal(read?.total, 0.5)

    // Mutating the returned object must not affect stored state.
    read!.total = 123
    const reread = await store.read()
    assert.equal(reread?.total, 0.5)
  })

  it('emits a non-durability warning by default', () => {
    const original = console.warn
    const messages: string[] = []
    console.warn = (msg: string) => messages.push(msg)
    try {
      new InMemorySpendStore()
    } finally {
      console.warn = original
    }
    assert.equal(messages.length, 1)
    assert.match(messages[0]!, /not durable/i)
  })

  it('stays silent when warn is false', () => {
    const original = console.warn
    let called = false
    console.warn = () => {
      called = true
    }
    try {
      new InMemorySpendStore({ warn: false })
    } finally {
      console.warn = original
    }
    assert.equal(called, false)
  })

  it('satisfies the SpendStore interface', () => {
    const store: SpendStore = new InMemorySpendStore({ warn: false })
    assert.equal(typeof store.read, 'function')
    assert.equal(typeof store.write, 'function')
  })
})
