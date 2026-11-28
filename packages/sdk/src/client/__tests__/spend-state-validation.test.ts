/**
 * The spend cap must not trust the shape or sign of what a SpendStore returns
 * (#760): null, {}, [], a missing or negative total all used to reset the cap
 * or raise its headroom. A malformed record now rejects the payment with a
 * typed error before any signing and leaves the stored state untouched, and a
 * rollback can never write a negative total.
 *
 * Run with: pnpm --filter @routedock/routedock test
 */

import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import { RouteDockClient } from '../RouteDockClient.js'
import { RouteDockPolicyRejectError } from '../../errors.js'
import { FileSpendStore } from '../../store/FileSpendStore.js'
import {
  InMemorySpendStore,
  parseDailySpend,
  spendScopeKey,
  type DailySpend,
  type SpendStore,
} from '../../store/SpendStore.js'
import type { RouteDockLogger } from '../../internal/logger.js'

const today = new Date().toISOString().slice(0, 10)
const ORIGIN = 'https://provider.test'
// One fixed wallet, so tests can address the client's scoped accumulator (#763).
const WALLET = Keypair.random()
const SCOPE = spendScopeKey('testnet', WALLET.publicKey(), 'USDC')

type Internals = {
  _checkAndReserveSpend(amount: string, endpointKey: string, asset: string): Promise<string>
  _rollbackSpend(reserveId: string): Promise<void>
}

const clientOn = (spendStore: SpendStore, extra: { logger?: RouteDockLogger } = {}) =>
  new RouteDockClient({
    wallet: WALLET,
    network: 'testnet',
    spendCap: { daily: '1', asset: 'USDC', endpointCaps: { [ORIGIN]: '1' } },
    spendStore,
    ...extra,
  }) as unknown as Internals

/** Every malformed shape from the issue's table, plus the other ways a record can be wrong. */
const MALFORMED: Array<[string, unknown]> = [
  ['null', null],
  ['{}', {}],
  ['[]', []],
  ['a string', 'oops'],
  ['a number', 5],
  ['missing totalMicros', { date: today, endpoints: {} }],
  ['numeric totalMicros', { date: today, totalMicros: 5, endpoints: {} }],
  ['negative totalMicros', { date: today, totalMicros: '-100000000', endpoints: {} }],
  ['fractional totalMicros', { date: today, totalMicros: '1.5', endpoints: {} }],
  ['non-numeric totalMicros', { date: today, totalMicros: 'abc', endpoints: {} }],
  ['empty totalMicros', { date: today, totalMicros: '', endpoints: {} }],
  ['missing endpoints', { date: today, totalMicros: '0' }],
  ['array endpoints', { date: today, totalMicros: '0', endpoints: [] }],
  ['negative endpoint total', { date: today, totalMicros: '0', endpoints: { [ORIGIN]: '-5' } }],
  ['non-integer endpoint total', { date: today, totalMicros: '0', endpoints: { [ORIGIN]: '1.5' } }],
  ['numeric endpoint total', { date: today, totalMicros: '0', endpoints: { [ORIGIN]: 5 } }],
  ['missing date', { totalMicros: '0', endpoints: {} }],
  ['bad date', { date: 'yesterday', totalMicros: '0', endpoints: {} }],
]

const isStateInvalid = (err: unknown): boolean =>
  err instanceof RouteDockPolicyRejectError && err.reason === 'local_spend_state_invalid'

let tmpDir: string
before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spend-state-'))
})
after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('parseDailySpend', () => {
  it('returns null only for an absent record and a clean copy for a valid one', () => {
    assert.equal(parseDailySpend(null), null)
    assert.equal(parseDailySpend(undefined), null)
    const valid = { date: today, totalMicros: '5000000', endpoints: { [ORIGIN]: '1' } }
    assert.deepEqual(parseDailySpend(valid), valid)
    assert.notEqual(parseDailySpend(valid), valid)
  })

  for (const [name, value] of MALFORMED.filter(([n]) => n !== 'null')) {
    it(`rejects ${name}`, () => {
      assert.throws(() => parseDailySpend(value), isStateInvalid)
    })
  }
})

describe('FileSpendStore spend file with the wrong shape', () => {
  for (const [name, value] of MALFORMED) {
    it(`pay() rejects a file containing ${name} and leaves it untouched`, async () => {
      const filePath = path.join(tmpDir, `bad-${name.replace(/\W+/g, '-')}.json`)
      const raw = JSON.stringify(value)
      await fs.writeFile(filePath, raw, 'utf-8')

      await assert.rejects(clientOn(new FileSpendStore(filePath))._checkAndReserveSpend('0.5', ORIGIN, 'USDC'), isStateInvalid)

      assert.equal(await fs.readFile(filePath, 'utf-8'), raw, 'the file must not be rewritten')
      await assert.rejects(fs.stat(`${filePath}.lock`), { code: 'ENOENT' }, 'lock released')
    })
  }

  it('read() itself throws the typed error with repair guidance', async () => {
    const filePath = path.join(tmpDir, 'guidance.json')
    await fs.writeFile(filePath, 'null', 'utf-8')
    await assert.rejects(
      new FileSpendStore(filePath).read(),
      (err: unknown) =>
        isStateInvalid(err) && /Delete or repair it before resuming/.test(String((err as Error).cause)),
    )
  })

  it('a missing file (ENOENT) still means zero spend', async () => {
    const filePath = path.join(tmpDir, 'absent.json')
    const store = new FileSpendStore(filePath)
    assert.equal(await store.read(SCOPE), null)
    await clientOn(store)._checkAndReserveSpend('0.5', ORIGIN, 'USDC')
    assert.equal((await store.read(SCOPE))?.totalMicros, '5000000')
  })

  it('a valid file is accepted and accumulates', async () => {
    const filePath = path.join(tmpDir, 'valid.json')
    await fs.writeFile(filePath, JSON.stringify({ date: today, totalMicros: '4000000', endpoints: {} }), 'utf-8')
    await clientOn(new FileSpendStore(filePath))._checkAndReserveSpend('0.5', ORIGIN, 'USDC')
    assert.equal((await new FileSpendStore(filePath).read(SCOPE))?.totalMicros, '9000000')
  })
})

describe('custom SpendStore returning malformed state', () => {
  /** A store with only read()/write(), like a hand-rolled Redis or SQL store. */
  function readWriteStore(returns: unknown) {
    const writes: DailySpend[] = []
    const store: SpendStore = {
      read: async () => returns as DailySpend | null,
      write: async (state) => void writes.push(state),
    }
    return { store, writes }
  }

  /** A store with an atomic update() that hands the callback whatever it holds. */
  function updateStore(returns: unknown) {
    const writes: DailySpend[] = []
    const store: SpendStore = {
      read: async () => returns as DailySpend | null,
      write: async (state) => void writes.push(state),
      update: async (fn) => {
        const next = fn(returns as DailySpend | null)
        if (next) writes.push(next)
        return next ?? null
      },
    }
    return { store, writes }
  }

  for (const [name, value] of MALFORMED.filter(([n]) => n !== 'null')) {
    it(`read()/write() store: ${name} rejects the payment and nothing is written`, async () => {
      const { store, writes } = readWriteStore(value)
      await assert.rejects(clientOn(store)._checkAndReserveSpend('0.5', ORIGIN, 'USDC'), isStateInvalid)
      assert.equal(writes.length, 0)
    })

    it(`update() store: ${name} rejects the payment and nothing is written`, async () => {
      const { store, writes } = updateStore(value)
      await assert.rejects(clientOn(store)._checkAndReserveSpend('0.5', ORIGIN, 'USDC'), isStateInvalid)
      assert.equal(writes.length, 0)
    })
  }

  it('a store returning null is still "nothing spent yet"', async () => {
    const { store, writes } = readWriteStore(null)
    await clientOn(store)._checkAndReserveSpend('0.5', ORIGIN, 'USDC')
    assert.equal(writes[0]?.totalMicros, '5000000')
  })
})

describe('rollback never goes negative', () => {
  it('clamps the global and per-endpoint totals at zero and warns', async () => {
    const store = new InMemorySpendStore({ warn: false })
    const logs: Array<[string, string]> = []
    const client = clientOn(store, { logger: (level, message) => void logs.push([level, message]) })

    const reserveId = await client._checkAndReserveSpend('0.5', ORIGIN, 'USDC')
    // The accumulator drops below the reservation (reset, hand edit, other process).
    await store.write({ date: today, totalMicros: '1000000', endpoints: { [ORIGIN]: '1000000' } }, SCOPE)
    // Reserve a second amount, then shrink the state so the release would go negative.
    await store.write({ date: today, totalMicros: '100', endpoints: { [ORIGIN]: '100' } }, SCOPE)

    await client._rollbackSpend(reserveId)

    const after = await store.read(SCOPE)
    assert.equal(after?.totalMicros, '0')
    assert.equal(after?.endpoints[ORIGIN], undefined, 'a per-endpoint total at or below zero is removed')
    assert.equal(logs.filter(([level]) => level === 'warn').length, 1)
    assert.match(logs[0]![1], /would have gone negative/)
  })

  it('does not warn on a normal rollback', async () => {
    const store = new InMemorySpendStore({ warn: false })
    const logs: string[] = []
    const client = clientOn(store, { logger: (_level, message) => void logs.push(message) })
    const reserveId = await client._checkAndReserveSpend('0.5', ORIGIN, 'USDC')
    await client._rollbackSpend(reserveId)
    assert.equal((await store.read(SCOPE))?.totalMicros, '0')
    assert.deepEqual(logs, [])
  })

  it('a rollback over a malformed record writes nothing', async () => {
    const store = new InMemorySpendStore({ warn: false })
    const client = clientOn(store)
    const reserveId = await client._checkAndReserveSpend('0.5', ORIGIN, 'USDC')
    await store.write({ date: today, totalMicros: '-5', endpoints: {} }, SCOPE)
    await assert.rejects(client._rollbackSpend(reserveId), isStateInvalid)
    assert.equal((await store.read(SCOPE))?.totalMicros, '-5', 'left as found')
  })
})
