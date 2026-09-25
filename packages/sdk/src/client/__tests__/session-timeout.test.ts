/**
 * Unit tests for the MppSessionClient wall-clock lifetime guard (#41) and the
 * auto-close failure signal (#400).
 *
 * These exercise the timer/event wiring only — they never reach the network.
 * The timer's close() is stubbed per test so the success and failure paths are
 * both deterministic; the real close() is only left in place for the
 * timer-cancellation test, where the guard must not fire at all.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Keypair } from '@stellar/stellar-sdk'
import { MppSessionClient } from '../MppSessionClient.js'
import { DEFAULT_MAX_SESSION_DURATION_MS } from '../../types.js'
import type {
  RouteDockManifest,
  SessionCloseFailedPayload,
  SessionEvent,
  SessionEventPayloadMap,
  SessionHandle,
} from '../../types.js'

/** Upper bound for every "the event should have fired by now" wait. */
const EVENT_WAIT_MS = 1000

/** Let the timer elapse and its close() settle before asserting a negative. */
const SETTLE_MS = 80

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
        channel_factory: 'CTEST_CHANNEL_CONTRACT',
        min_deposit: '0.10',
        refund_waiting_period_ledgers: 17_280,
      },
    },
    endpoints: { stream: { method: 'GET', path: '/stream' } },
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

/** Resolves with the event's payload, or rejects if it never fires. */
function waitForEvent<E extends SessionEvent>(
  session: SessionHandle,
  event: E,
): Promise<SessionEventPayloadMap[E]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${event} never fired`)),
      EVENT_WAIT_MS,
    )
    session.on(event, (payload) => {
      clearTimeout(timer)
      resolve(payload)
    })
  })
}

/** Replaces close() with a stub that rejects, so the failure path is instant. */
function failCloseWith(session: SessionHandle, error: unknown): () => number {
  let calls = 0
  session.close = () => {
    calls++
    return Promise.reject(error)
  }
  return () => calls
}

/** Replaces close() with a stub that resolves, so the success path is instant. */
function succeedClose(session: SessionHandle): () => number {
  let calls = 0
  session.close = () => {
    calls++
    return Promise.resolve({
      closeTxHash: 'STUB_CLOSE_HASH',
      totalPaid: '0.0000000',
      vouchersIssued: 0,
    })
  }
  return () => calls
}

/** Collects unhandled rejections for the duration of `run`. */
async function withUnhandledRejectionSpy(run: () => Promise<void>): Promise<unknown[]> {
  const rejections: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    rejections.push(reason)
  }
  process.on('unhandledRejection', onUnhandled)
  try {
    await run()
    // Unhandled rejections are reported on a later tick than the await above.
    await new Promise((r) => setTimeout(r, 50))
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
  return rejections
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

// ── Auto-close failure signal (#400) ──────────────────────────────────────────

test('successful auto-close emits no session:close-failed', async () => {
  // #given a session whose auto-close resolves
  const session = await newSession(20)
  const closeCalls = succeedClose(session)
  const failures: SessionCloseFailedPayload[] = []
  session.on('session:close-failed', (p) => {
    failures.push(p)
  })

  // #when the lifetime guard fires and close() succeeds
  await new Promise((r) => setTimeout(r, SETTLE_MS))

  // #then the close ran, and no failure was reported
  assert.equal(closeCalls(), 1)
  assert.deepEqual(failures, [])
})

test('rejected auto-close emits session:close-failed with the rejection', async () => {
  // #given a session whose auto-close rejects
  const session = await newSession(20)
  const failure = new Error('close RPC unavailable')
  failCloseWith(session, failure)

  // #when the lifetime guard fires
  const payload = await waitForEvent(session, 'session:close-failed')

  // #then the rejection and the elapsed budget are delivered to the listener
  assert.equal(payload.error, failure)
  assert.equal(payload.maxDurationMs, 20)
})

test('rejected auto-close emits session:close-failed exactly once', async () => {
  // #given a session whose auto-close rejects
  const session = await newSession(20)
  failCloseWith(session, new Error('close RPC unavailable'))
  let count = 0
  session.on('session:close-failed', () => {
    count++
  })

  // #when the lifetime guard fires and the rejection settles
  await new Promise((r) => setTimeout(r, SETTLE_MS))

  // #then the listener saw a single failure event
  assert.equal(count, 1)
})

test('rejected auto-close warns through console.warn', async () => {
  // #given console.warn replaced with a collector
  const warnings: unknown[][] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => {
    warnings.push(args)
  }

  try {
    // #when the lifetime guard fires and close() rejects
    const session = await newSession(20)
    const failure = new Error('close RPC unavailable')
    failCloseWith(session, failure)
    await waitForEvent(session, 'session:close-failed')

    // #then the operator gets a warning naming the elapsed budget and the error
    assert.equal(warnings.length, 1)
    const [message, reported] = warnings[0] ?? []
    assert.match(String(message), /maxDuration auto-close failed/)
    assert.match(String(message), /20ms/)
    assert.equal(reported, failure)
  } finally {
    console.warn = originalWarn
  }
})

test('a throwing session:close-failed listener neither escapes nor blocks others', async () => {
  // #given two listeners, the first of which throws
  const session = await newSession(20)
  failCloseWith(session, new Error('close RPC unavailable'))
  const seen: SessionCloseFailedPayload[] = []
  session.on('session:close-failed', () => {
    throw new Error('listener exploded')
  })
  session.on('session:close-failed', (p) => {
    seen.push(p)
  })

  // #when the failure event is emitted
  const rejections = await withUnhandledRejectionSpy(async () => {
    await new Promise((r) => setTimeout(r, SETTLE_MS))
  })

  // #then the throw is contained and the second listener still ran
  assert.equal(rejections.length, 0, `unhandled rejection: ${String(rejections[0])}`)
  assert.equal(seen.length, 1)
})

test('an async listener that rejects does not cause an unhandled rejection', async () => {
  // #given a listener returning a rejected promise
  const session = await newSession(20)
  failCloseWith(session, new Error('close RPC unavailable'))
  let sawFailure = false
  session.on('session:close-failed', () => {
    return Promise.reject(new Error('async listener exploded'))
  })
  session.on('session:close-failed', () => {
    sawFailure = true
  })

  // #when the failure event is emitted
  const rejections = await withUnhandledRejectionSpy(async () => {
    await new Promise((r) => setTimeout(r, SETTLE_MS))
  })

  // #then the rejected listener promise is swallowed
  assert.equal(rejections.length, 0, `unhandled rejection: ${String(rejections[0])}`)
  assert.equal(sawFailure, true)
})
