/**
 * Tests for RouteDockClient.getSpendStatus().
 *
 * Verifies the status reflects a committed payment, drops a rolled-back one,
 * reports null caps without a spendCap, resets on a new day, and reports
 * per-endpoint caps, against both InMemorySpendStore and FileSpendStore.
 *
 * Run with: pnpm --filter @routedock/routedock test
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Keypair } from '@stellar/stellar-sdk'
import { RouteDockClient } from '../RouteDockClient.js'
import { InMemorySpendStore, spendScopeKey, type SpendStore } from '../../store/SpendStore.js'
import { FileSpendStore } from '../../store/FileSpendStore.js'

const ORIGIN = 'https://api.example.com'

/** Private reserve/commit/rollback hooks, the same path pay() takes. */
interface SpendInternals {
  _checkAndReserveSpend(amount: string, endpointKey: string, asset: string): Promise<string>
  _commitSpend(reserveId: string): Promise<void>
  _rollbackSpend(reserveId: string): Promise<void>
}

function internals(client: RouteDockClient): SpendInternals {
  return client as unknown as SpendInternals
}

// One fixed wallet, so a test can write straight to the client's scoped accumulator (#763).
const WALLET = Keypair.random()
const SCOPE = spendScopeKey('testnet', WALLET.publicKey(), 'USDC')

function makeClient(store: SpendStore, spendCap?: ConstructorParameters<typeof RouteDockClient>[0]['spendCap']) {
  return new RouteDockClient({
    wallet: WALLET,
    network: 'testnet',
    spendStore: store,
    ...(spendCap ? { spendCap } : {}),
  })
}

const tmpDir = mkdtempSync(join(tmpdir(), 'spend-status-'))

const stores: Array<[string, () => SpendStore]> = [
  ['InMemorySpendStore', () => new InMemorySpendStore({ warn: false })],
  ['FileSpendStore', () => new FileSpendStore(join(tmpDir, `spend-${Math.random().toString(36).slice(2)}.json`))],
]

try {
  for (const [label, makeStore] of stores) {
    // ── Fresh store ─────────────────────────────────────────────────────────
    {
      const client = makeClient(makeStore(), { daily: '1.00', asset: 'USDC' })
      const status = await client.getSpendStatus()
      assert.equal(status.asset, 'USDC', `${label}: asset`)
      assert.equal(status.daily, '1.00', `${label}: daily cap`)
      assert.equal(status.spentToday, '0', `${label}: nothing spent yet`)
      assert.equal(status.remainingToday, '1', `${label}: full budget remaining`)
      assert.equal(status.day, new Date().toISOString().slice(0, 10), `${label}: day is today (UTC)`)
      assert.equal(status.endpoints, undefined, `${label}: no endpoints without endpointCaps`)
    }

    // ── Committed payment is reflected ──────────────────────────────────────
    {
      const client = makeClient(makeStore(), { daily: '1.00', asset: 'USDC' })
      const id = await internals(client)._checkAndReserveSpend('0.25', ORIGIN, 'USDC')
      await internals(client)._commitSpend(id)

      const status = await client.getSpendStatus()
      assert.equal(status.spentToday, '0.25', `${label}: committed payment counts`)
      assert.equal(status.remainingToday, '0.75', `${label}: remaining shrinks by the committed payment`)
    }

    // ── Rolled-back payment is not reflected ────────────────────────────────
    {
      const client = makeClient(makeStore(), { daily: '1.00', asset: 'USDC' })
      const kept = await internals(client)._checkAndReserveSpend('0.25', ORIGIN, 'USDC')
      await internals(client)._commitSpend(kept)
      const failed = await internals(client)._checkAndReserveSpend('0.40', ORIGIN, 'USDC')

      const inFlight = await client.getSpendStatus()
      assert.equal(inFlight.spentToday, '0.65', `${label}: in-flight reservation counts until resolved`)

      await internals(client)._rollbackSpend(failed)
      const status = await client.getSpendStatus()
      assert.equal(status.spentToday, '0.25', `${label}: rolled-back payment is excluded`)
      assert.equal(status.remainingToday, '0.75', `${label}: rolled-back payment is returned to the budget`)
    }

    // ── Per-endpoint caps ───────────────────────────────────────────────────
    {
      const client = makeClient(makeStore(), {
        daily: '1.00',
        asset: 'USDC',
        endpointCaps: { 'https://API.example.com/': '0.50', 'https://other.example.com': '0.10' },
      })
      const id = await internals(client)._checkAndReserveSpend('0.20', ORIGIN, 'USDC')
      await internals(client)._commitSpend(id)

      const status = await client.getSpendStatus()
      assert.deepEqual(
        status.endpoints,
        {
          [ORIGIN]: { cap: '0.50', spent: '0.2' },
          'https://other.example.com': { cap: '0.10', spent: '0' },
        },
        `${label}: per-endpoint caps (normalized origin keys) and spend`,
      )
      assert.equal(status.spentToday, '0.2', `${label}: endpoint spend also counts globally`)
    }

    // ── Remaining never goes negative ───────────────────────────────────────
    {
      const store = makeStore()
      const client = makeClient(store, { daily: '0.10', asset: 'USDC' })
      await store.write({
        date: new Date().toISOString().slice(0, 10),
        totalMicros: '5000000', // 0.5 USDC, above the 0.10 cap
        endpoints: {},
      }, SCOPE)
      const status = await client.getSpendStatus()
      assert.equal(status.spentToday, '0.5', `${label}: over-cap spend is reported as stored`)
      assert.equal(status.remainingToday, '0', `${label}: remaining is clamped at zero`)
    }

    // ── A previous day's accumulator reads as zero ──────────────────────────
    {
      const store = makeStore()
      const client = makeClient(store, { daily: '1.00', asset: 'USDC' })
      await store.write({ date: '2000-01-01', totalMicros: '9000000', endpoints: { [ORIGIN]: '9000000' } }, SCOPE)
      const status = await client.getSpendStatus()
      assert.equal(status.spentToday, '0', `${label}: stale day is not counted`)
      assert.equal(status.remainingToday, '1', `${label}: stale day does not reduce the budget`)
    }

    // ── No spendCap: null caps ──────────────────────────────────────────────
    {
      const client = makeClient(makeStore())
      const status = await client.getSpendStatus()
      assert.equal(status.daily, null, `${label}: daily is null without a spendCap`)
      assert.equal(status.remainingToday, null, `${label}: remainingToday is null without a spendCap`)
      assert.equal(status.spentToday, '0', `${label}: spentToday is still reported`)
      assert.equal(status.endpoints, undefined, `${label}: no endpoints without a spendCap`)
    }
  }

  // ── Reads are serialized behind an in-flight reservation ──────────────────
  {
    const store = new InMemorySpendStore({ warn: false })
    const client = makeClient(store, { daily: '1.00', asset: 'USDC' })

    // Start a reservation and a status read without awaiting in between: the
    // read must queue behind the reservation and see it.
    const reserving = internals(client)._checkAndReserveSpend('0.30', ORIGIN, 'USDC')
    const reading = client.getSpendStatus()
    await reserving
    assert.equal((await reading).spentToday, '0.3', 'status read queues behind a pending reservation')
  }

  // ── Unreadable store propagates instead of reporting a false zero ─────────
  {
    const badPath = join(tmpDir, 'corrupt.json')
    writeFileSync(badPath, '{not json')
    const client = makeClient(new FileSpendStore(badPath), { daily: '1.00', asset: 'USDC' })
    await assert.rejects(() => client.getSpendStatus(), 'a corrupt store must not read as zero spend')
  }

  console.log('spend-status tests passed')
} finally {
  rmSync(tmpDir, { recursive: true, force: true })
}
