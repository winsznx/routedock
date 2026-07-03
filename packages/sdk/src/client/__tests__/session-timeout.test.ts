/**
 * Unit tests for the MppSessionClient wall-clock lifetime guard (#41).
 *
 * These exercise the timer/event wiring only — they never reach the network.
 * On timeout the handle attempts an on-chain close() which fails offline; that
 * failure is swallowed by design, so the assertions focus on the emitted
 * 'session:timeout' event and the timer-cancellation contract.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@stellar/stellar-sdk'
import { MppSessionClient } from '../MppSessionClient.js'
import { DEFAULT_MAX_SESSION_DURATION_MS } from '../../types.js'
import type { RouteDockManifest } from '../../types.js'

function manifest(): RouteDockManifest {
  return {
    routedock: '1.0',
    name: 'Test Provider',
    description: 'session-timeout fixture',
    modes: ['mpp-session'],
    network: 'testnet',
    asset: 'USDC',
    asset_contract: 'CTEST_ASSET',
    payee: 'GTEST_PAYEE',
    pricing: {
      'mpp-session': {
        rate: '0.0001',
        per: 'voucher',
        channel_contract: 'CTEST_CHANNEL_CONTRACT',
        min_deposit: '0.10',
        refund_waiting_period_ledgers: 17_280,
      },
    },
    endpoints: { stream: 'GET /stream' },
    tags: ['test'],
  }
}

function newSession(maxDurationMs?: number) {
  const client = new MppSessionClient(Keypair.random(), 'testnet')
  return client.openSession(
    'https://provider.test/stream',
    manifest(),
    Keypair.random().secret(),
    maxDurationMs === undefined ? undefined : { maxDurationMs },
  )
}

test('emits session:timeout after maxDurationMs elapses', async () => {
  const session = await newSession(20)
  const payload = await new Promise<{ maxDurationMs: number }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('session:timeout never fired')), 1000)
    session.on('session:timeout', (p) => {
      clearTimeout(timer)
      resolve(p)
    })
  })
  assert.equal(payload.maxDurationMs, 20)
})

test('manual close() cancels the guard so it never fires', async () => {
  const session = await newSession(30)
  let fired = false
  session.on('session:timeout', () => {
    fired = true
  })
  // close() clears the timer synchronously before any await; the offline
  // on-chain call then rejects, which we ignore.
  await session.close().catch(() => {})
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(fired, false, 'timeout fired after the session was already closed')
})

test('maxDurationMs <= 0 disables the guard', async () => {
  const session = await newSession(0)
  let fired = false
  session.on('session:timeout', () => {
    fired = true
  })
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(fired, false, 'guard fired despite being disabled')
})

test('default budget is one hour', () => {
  assert.equal(DEFAULT_MAX_SESSION_DURATION_MS, 3_600_000)
})
