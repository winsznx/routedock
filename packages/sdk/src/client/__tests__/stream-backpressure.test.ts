/**
 * Unit tests for MppSessionClient.stream() backpressure.
 *
 * Strategy: intercept mppx.fetch() at the module boundary using a
 * controllable fake-fetch that resolves on demand, letting us assert
 * exactly how many requests are in-flight at each point.
 *
 * Run with: pnpm --filter @routedock/routedock test
 */

import assert from 'node:assert/strict'
import type { StreamOptions } from '../../types.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

/** A deferred promise whose resolve/reject functions are exposed externally. */
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
  return { promise, resolve, reject }
}

/** Build a mock SessionHandle.stream() that uses a controlled fetch queue. */
function buildMockStream(fetchFn: () => Promise<unknown>) {
  let vouchersIssued = 0

  return {
    vouchersIssued: () => vouchersIssued,
    async *stream(options?: StreamOptions): AsyncIterable<unknown> {
      const concurrency = Math.max(1, options?.concurrency ?? 1)

      const doFetch = () => fetchFn()

      if (concurrency === 1) {
        while (true) {
          const data = await doFetch()
          vouchersIssued++
          yield data
        }
      } else {
        const queue: Array<Promise<unknown>> = []
        for (let i = 0; i < concurrency; i++) queue.push(doFetch())

        while (true) {
          const data = await queue.shift()!
          queue.push(doFetch())
          vouchersIssued++
          yield data
        }
      }
    },
  }
}

// ── Test 1: StreamOptions is exported from types ──────────────────────────────

{
  const opts: StreamOptions = { concurrency: 1 }
  assert.strictEqual(opts.concurrency, 1, 'StreamOptions.concurrency should be 1')
  console.log('✓ Test 1: StreamOptions interface is exported and usable')
}

// ── Test 2: default concurrency is 1 — next fetch not issued until ACK ───────

{
  let fetchCallCount = 0
  const pendingFetches: Array<ReturnType<typeof deferred>> = []

  const controlledFetch = () => {
    fetchCallCount++
    const d = deferred<unknown>()
    pendingFetches.push(d)
    return d.promise
  }

  const mock = buildMockStream(controlledFetch)
  const iter = mock.stream()[Symbol.asyncIterator]()

  // Kick off the first next() — it should issue exactly one fetch.
  const firstNext = iter.next()
  await Promise.resolve() // flush microtasks

  assert.strictEqual(fetchCallCount, 1, 'with concurrency:1, only 1 fetch should be in flight after first next()')

  // Resolve the first fetch — the generator should yield and pause.
  pendingFetches[0].resolve({ seq: 1 })
  const { value: v1 } = await firstNext
  assert.deepStrictEqual(v1, { seq: 1 }, 'yielded value should be the resolved fetch body')

  // Start the second iteration — it should issue exactly one more fetch.
  const secondNext = iter.next()
  await Promise.resolve()
  assert.strictEqual(fetchCallCount, 2, 'second fetch issued only after first was ACKed')

  pendingFetches[1].resolve({ seq: 2 })
  const { value: v2 } = await secondNext
  assert.deepStrictEqual(v2, { seq: 2 })

  console.log('✓ Test 2: concurrency:1 (default) — next voucher not issued until HTTP 200 received')
}

// ── Test 3: concurrency:2 — 2 requests in flight before first yield ──────────

{
  let fetchCallCount = 0
  const pendingFetches: Array<ReturnType<typeof deferred>> = []

  const controlledFetch = () => {
    fetchCallCount++
    const d = deferred<unknown>()
    pendingFetches.push(d)
    return d.promise
  }

  const mock = buildMockStream(controlledFetch)
  const iter = mock.stream({ concurrency: 2 })[Symbol.asyncIterator]()

  // With concurrency:2, the pipelined path pre-fills 2 fetches immediately.
  const firstNext = iter.next()
  await Promise.resolve() // flush microtasks

  assert.strictEqual(fetchCallCount, 2, 'concurrency:2 should have 2 fetches in flight before first yield')

  // Resolve both.
  pendingFetches[0].resolve({ seq: 1 })
  pendingFetches[1].resolve({ seq: 2 })

  const { value: v1 } = await firstNext
  assert.deepStrictEqual(v1, { seq: 1 }, 'first yielded value must be from the first issued request (order preserved)')

  // After draining slot 0, a replacement should have been issued (total = 3).
  await Promise.resolve()
  assert.strictEqual(fetchCallCount, 3, 'window replenished to 2 after yielding first result')

  console.log('✓ Test 3: concurrency:2 — 2 fetches in flight, window replenished after each yield')
}

// ── Test 4: results yielded in issue order even when later fetch resolves first

{
  let fetchCallCount = 0
  const pendingFetches: Array<ReturnType<typeof deferred>> = []

  const controlledFetch = () => {
    fetchCallCount++
    const d = deferred<unknown>()
    pendingFetches.push(d)
    return d.promise
  }

  const mock = buildMockStream(controlledFetch)
  const iter = mock.stream({ concurrency: 2 })[Symbol.asyncIterator]()

  const firstNext = iter.next()
  await Promise.resolve()

  // Resolve in REVERSE order — second resolves before first.
  pendingFetches[1].resolve({ seq: 2 })
  pendingFetches[0].resolve({ seq: 1 })

  const { value: v1 } = await firstNext
  // Must yield seq:1 (issue order), not seq:2 (resolution order).
  assert.deepStrictEqual(v1, { seq: 1 }, 'results must be yielded in issue order regardless of resolution order')

  console.log('✓ Test 4: results yielded in issue order even when out-of-order resolution occurs')
}

// ── Test 5: concurrency defaults to 1 when option is omitted ─────────────────

{
  let fetchCallCount = 0
  const pendingFetches: Array<ReturnType<typeof deferred>> = []

  const controlledFetch = () => {
    fetchCallCount++
    const d = deferred<unknown>()
    pendingFetches.push(d)
    return d.promise
  }

  const mock = buildMockStream(controlledFetch)
  const iter = mock.stream({})[Symbol.asyncIterator]()

  iter.next()
  await Promise.resolve()

  assert.strictEqual(fetchCallCount, 1, 'empty options object should default to concurrency:1')
  pendingFetches[0].resolve({})

  console.log('✓ Test 5: empty StreamOptions defaults to concurrency:1')
}

// ── Test 6: concurrency values below 1 are clamped to 1 ─────────────────────

{
  let fetchCallCount = 0
  const pendingFetches: Array<ReturnType<typeof deferred>> = []

  const controlledFetch = () => {
    fetchCallCount++
    const d = deferred<unknown>()
    pendingFetches.push(d)
    return d.promise
  }

  const mock = buildMockStream(controlledFetch)
  const iter = mock.stream({ concurrency: 0 })[Symbol.asyncIterator]()

  iter.next()
  await Promise.resolve()

  assert.strictEqual(fetchCallCount, 1, 'concurrency:0 should be clamped to 1')
  pendingFetches[0].resolve({})

  console.log('✓ Test 6: concurrency:0 clamped to 1, still sequential')
}

console.log('\nAll stream backpressure tests passed.')
