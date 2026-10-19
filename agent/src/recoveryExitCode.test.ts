import { test } from 'node:test'
import assert from 'node:assert/strict'
import { exitCodeFor } from './recoveryExitCode.js'

test('partial recovery fails', () => assert.equal(exitCodeFor({ recoveredCount: 1, failedCount: 3 }), 1))
test('all recovered succeeds', () => assert.equal(exitCodeFor({ recoveredCount: 2, failedCount: 0 }), 0))
test('no sessions succeeds', () => assert.equal(exitCodeFor({ recoveredCount: 0, failedCount: 0 }), 0))
