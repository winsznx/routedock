/**
 * Unit tests for the session recovery CLI's exit code.
 *
 * Run with: pnpm --filter agent test
 *
 * These are pure-function tests. They never call `process.exit` and never touch
 * Supabase or Stellar, so they run without credentials or network access.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { exitCodeFor } from '../src/recoveryExitCode.js'

test('exits 0 when no orphaned session was found', () => {
  assert.equal(exitCodeFor({ recoveredCount: 0, failedCount: 0 }), 0)
})

test('exits 0 when every orphaned session was recovered', () => {
  assert.equal(exitCodeFor({ recoveredCount: 2, failedCount: 0 }), 0)
})

test('exits 1 when every orphaned session failed', () => {
  assert.equal(exitCodeFor({ recoveredCount: 0, failedCount: 2 }), 1)
})

test('exits 1 on a partial failure, even though other channels recovered', () => {
  // The regression this guards: the exit code used to be chosen by checking
  // `recoveredCount > 0` first, so a run with one recovery and three failures
  // printed success and exited 0. Anything gating on the exit code treated it
  // as a clean run and never alerted on the three unsettled channels.
  assert.equal(exitCodeFor({ recoveredCount: 1, failedCount: 3 }), 1)
})

test('exits 1 when a single channel failed out of many', () => {
  assert.equal(exitCodeFor({ recoveredCount: 9, failedCount: 1 }), 1)
})
