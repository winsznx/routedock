/**
 * Unit tests for MppSessionClient.stream() pipelined unhandled rejection handling (#397).
 *
 * Directly exercises MppSessionClient by intercepting globalThis.fetch to simulate
 * in-flight voucher request rejections and consumer loop cancellations.
 *
 * Verifies:
 *   1. With concurrency: 3, a mocked fetch where slot 2 rejects before slot 1 resolves
 *      produces zero unhandledRejection events, and consumer receives slot 1 data
 *      followed by slot 2's error from the iterator.
 *   2. Breaking out of for await after first item while other slots later reject
 *      produces zero unhandledRejection events.
 *   3. When head slot rejects while other slots are still in flight, error propagates
 *      to consumer and zero unhandledRejection events fire.
 *   4. When onSpend throws during replenish, spend error propagates and queued slots
 *      do not cause unhandledRejection.
 */

import assert from 'node:assert/strict'
import { Keypair } from '@stellar/stellar-sdk'
import { MppSessionClient } from '../MppSessionClient.js'
import { signManifest } from '../../manifest/sign.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function deferred<T = unknown>(): {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
} {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  // Pre-catch mock deferred so the mock itself doesn't trigger unhandledRejection
  promise.catch(() => {})
  return { promise, resolve, reject }
}

const clientKeypair = Keypair.random()
const commitmentKeypair = Keypair.random()
const client = new MppSessionClient(clientKeypair, 'testnet', { maxAttempts: 1 })

const payeeKeypair = Keypair.random()
const manifest = signManifest(
  {
    routedock: '1.0',
    name: 'test-agent',
    description: 'Test agent for stream pipelining',
    modes: ['mpp-session'],
    network: 'testnet',
    asset: 'USDC',
    asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    payee: payeeKeypair.publicKey(),
    pricing: {
      'mpp-session': {
        rate: '0.0001',
        per: 'voucher',
        channel_factory: 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH',
        min_deposit: '0.10',
        refund_waiting_period_ledgers: 17280,
      },
    },
    endpoints: { test: { method: 'GET', path: '/test' } },
    tags: ['test'],
  },
  payeeKeypair.secret(),
)

function makeOkResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function createMockFetch(defs: { promise: Promise<Response>; resolve: (v: Response) => void; reject: (e: unknown) => void }[]) {
  let callCount = 0
  return async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const d = defs[callCount++] ?? deferred<Response>()
    if (init?.signal) {
      if (init.signal.aborted) {
        d.reject(new DOMException('This operation was aborted', 'AbortError'))
      } else {
        init.signal.addEventListener('abort', () => {
          d.reject(new DOMException('This operation was aborted', 'AbortError'))
        })
      }
    }
    return d.promise
  }
}

// ── Test Runner ───────────────────────────────────────────────────────────────

async function runTests() {
  const originalFetch = globalThis.fetch

  try {
    // ── Test 1 ─────────────────────────────────────────────────────────────────
    // Concurrency 3: slot 2 rejects BEFORE slot 1 resolves.
    // Consumer must receive slot 1 then slot 2 error.
    // 0 unhandledRejection events.
    {
      const unhandled: unknown[] = []
      const onUnhandled = (reason: unknown) => unhandled.push(reason)
      process.on('unhandledRejection', onUnhandled)

      const d1 = deferred<Response>()
      const d2 = deferred<Response>()
      const d3 = deferred<Response>()
      const defs = [d1, d2, d3]
      globalThis.fetch = createMockFetch(defs)

      const handle = await client.openSession(
        'http://127.0.0.1:9999/test',
        manifest,
        commitmentKeypair.secret(),
      )

      const iterator = handle.stream({ concurrency: 3 })[Symbol.asyncIterator]()

      // Wait a tick so all 3 initial requests are in flight
      await new Promise((r) => setTimeout(r, 20))

      // Slot 2 rejects BEFORE slot 1 resolves
      const slot2Error = new Error('Slot 2 network error')
      d2.reject(slot2Error)

      // Allow microtasks to settle
      await new Promise((r) => setTimeout(r, 20))

      // Slot 1 resolves successfully
      d1.resolve(makeOkResponse({ item: 1 }))

      // Consumer reads: slot 1 should succeed
      const first = await iterator.next()
      assert.equal(first.done, false)
      assert.deepEqual(first.value, { item: 1 })

      // Next read: slot 2 error should throw
      let threw = false
      try {
        await iterator.next()
      } catch (err: any) {
        threw = true
        assert.ok(
          err.message.includes('Slot 2 network error') ||
            err.message.includes('Voucher request failed'),
          `Unexpected error message: ${err.message}`,
        )
      }
      assert.ok(threw, 'Expected iterator.next() to throw slot 2 error')

      // Resolve slot 3 so it doesn't linger
      d3.resolve(makeOkResponse({ item: 3 }))
      await new Promise((r) => setTimeout(r, 30))

      process.removeListener('unhandledRejection', onUnhandled)
      assert.equal(
        unhandled.length,
        0,
        `Expected 0 unhandledRejections, got: ${unhandled.map((e: any) => e?.message ?? e).join(', ')}`,
      )
      console.log('✓ Test 1: real client with slot 2 rejecting before slot 1 -> 0 unhandledRejections')
    }

    // ── Test 2 ─────────────────────────────────────────────────────────────────
    // Break out of for await after first item; subsequent queued fetches later reject.
    // Must produce 0 unhandledRejection events.
    {
      const unhandled: unknown[] = []
      const onUnhandled = (reason: unknown) => unhandled.push(reason)
      process.on('unhandledRejection', onUnhandled)

      const d1 = deferred<Response>()
      const d2 = deferred<Response>()
      const d3 = deferred<Response>()
      const defs = [d1, d2, d3]
      globalThis.fetch = createMockFetch(defs)

      const handle = await client.openSession(
        'http://127.0.0.1:9999/test',
        manifest,
        commitmentKeypair.secret(),
      )

      d1.resolve(makeOkResponse({ item: 'first' }))

      for await (const item of handle.stream({ concurrency: 3 })) {
        assert.deepEqual(item, { item: 'first' })
        break // Consumer exits early; finally block runs
      }

      // Remaining queued slots now reject after consumer has already broken out
      d2.reject(new Error('Late rejection in slot 2'))
      d3.reject(new Error('Late rejection in slot 3'))

      await new Promise((r) => setTimeout(r, 50))

      process.removeListener('unhandledRejection', onUnhandled)
      assert.equal(
        unhandled.length,
        0,
        `Expected 0 unhandledRejections on break, got: ${unhandled.map((e: any) => e?.message ?? e).join(', ')}`,
      )
      console.log('✓ Test 2: real client breaking out of for await while slots later reject -> 0 unhandledRejections')
    }

    // ── Test 3 ─────────────────────────────────────────────────────────────────
    // Head slot rejects while other slots are still in flight.
    // Error must propagate to consumer, and other in-flight slots must not leak unhandled.
    {
      const unhandled: unknown[] = []
      const onUnhandled = (reason: unknown) => unhandled.push(reason)
      process.on('unhandledRejection', onUnhandled)

      const d1 = deferred<Response>()
      const d2 = deferred<Response>()
      const d3 = deferred<Response>()
      const defs = [d1, d2, d3]
      globalThis.fetch = createMockFetch(defs)

      const handle = await client.openSession(
        'http://127.0.0.1:9999/test',
        manifest,
        commitmentKeypair.secret(),
      )

      // Head slot rejects immediately
      d1.reject(new Error('Head slot failed'))

      let threw = false
      try {
        for await (const _ of handle.stream({ concurrency: 3 })) {
          // Should not yield
        }
      } catch (err: any) {
        threw = true
        assert.ok(
          err.message.includes('Head slot failed') ||
            err.message.includes('Voucher request failed'),
          `Unexpected error: ${err.message}`,
        )
      }
      assert.ok(threw, 'Expected stream to throw on head slot rejection')

      // Other slots subsequently reject
      d2.reject(new Error('Slot 2 downstream failure'))
      d3.reject(new Error('Slot 3 downstream failure'))

      await new Promise((r) => setTimeout(r, 50))

      process.removeListener('unhandledRejection', onUnhandled)
      assert.equal(
        unhandled.length,
        0,
        `Expected 0 unhandledRejections, got: ${unhandled.map((e: any) => e?.message ?? e).join(', ')}`,
      )
      console.log('✓ Test 3: real client head slot rejection with in-flight queue -> 0 unhandledRejections')
    }

    // ── Test 4 ─────────────────────────────────────────────────────────────────
    // onSpend throws during replenishment; remaining in-flight slots must not leak.
    {
      const unhandled: unknown[] = []
      const onUnhandled = (reason: unknown) => unhandled.push(reason)
      process.on('unhandledRejection', onUnhandled)

      let spendCount = 0
      const onSpend = async (_rate: string) => {
        spendCount++
        if (spendCount === 3) {
          throw new Error('Daily spend cap exceeded on replenish')
        }
      }

      const d1 = deferred<Response>()
      const d2 = deferred<Response>()
      const defs = [d1, d2]
      globalThis.fetch = createMockFetch(defs)

      const handle = await client.openSession(
        'http://127.0.0.1:9999/test',
        manifest,
        commitmentKeypair.secret(),
        undefined,
        onSpend,
      )

      // Concurrency 2: calls 1 and 2 checkSpend pass.
      // Draining slot 1 will call replenish -> checkSpend 3 -> throws.
      d1.resolve(makeOkResponse({ item: 'one' }))

      let threw = false
      try {
        for await (const _ of handle.stream({ concurrency: 2 })) {
          // First item consumed, next replenishment triggers spend error
        }
      } catch (err: any) {
        threw = true
        assert.ok(
          err.message.includes('Daily spend cap exceeded'),
          `Unexpected error: ${err.message}`,
        )
      }
      assert.ok(threw, 'Expected spend cap error to propagate')

      // Pending slot 2 now rejects
      d2.reject(new Error('Slot 2 orphan rejection'))
      await new Promise((r) => setTimeout(r, 50))

      process.removeListener('unhandledRejection', onUnhandled)
      assert.equal(
        unhandled.length,
        0,
        `Expected 0 unhandledRejections, got: ${unhandled.map((e: any) => e?.message ?? e).join(', ')}`,
      )
      console.log('✓ Test 4: real client spend error during replenish -> 0 unhandledRejections')
    }

    console.log('\nAll stream pipelined rejection tests passed on real MppSessionClient.')
  } finally {
    globalThis.fetch = originalFetch
  }
}

await runTests()
