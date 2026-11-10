import assert from 'node:assert/strict'
import { exitCodeFor, resolveRecoveryOutcome } from '../src/recover-sessions.js'

// 1. Partial failure (failedCount > 0 and recoveredCount > 0) -> exit 1 with errors message
{
  const outcome = resolveRecoveryOutcome({
    orphanedCount: 4,
    recoveredCount: 1,
    skippedCount: 0,
    failedCount: 3,
  })
  assert.equal(outcome.exitCode, 1)
  assert.equal(exitCodeFor({ recoveredCount: 1, failedCount: 3 }), 1)
  assert.equal(outcome.message, '[SessionRecovery] ✗ Session recovery completed with errors')
  assert.ok(!outcome.message.includes('completed successfully'))
}

// 2. Total failure (failedCount > 0 and recoveredCount === 0) -> exit 1 with errors message
{
  const outcome = resolveRecoveryOutcome({
    orphanedCount: 2,
    recoveredCount: 0,
    skippedCount: 0,
    failedCount: 2,
  })
  assert.equal(outcome.exitCode, 1)
  assert.equal(exitCodeFor({ recoveredCount: 0, failedCount: 2 }), 1)
  assert.equal(outcome.message, '[SessionRecovery] ✗ Session recovery completed with errors')
}

// 3. Full recovery (failedCount === 0 and recoveredCount > 0) -> exit 0 with success message
{
  const outcome = resolveRecoveryOutcome({
    orphanedCount: 2,
    recoveredCount: 2,
    skippedCount: 1,
    failedCount: 0,
  })
  assert.equal(outcome.exitCode, 0)
  assert.equal(exitCodeFor({ recoveredCount: 2, failedCount: 0 }), 0)
  assert.equal(outcome.message, '[SessionRecovery] ✓ Session recovery completed successfully')
}

// 4. No orphans / only skipped (all recovery & failure counts 0) -> exit 0 with no-orphans message
{
  const outcome = resolveRecoveryOutcome({
    orphanedCount: 0,
    recoveredCount: 0,
    skippedCount: 0,
    failedCount: 0,
  })
  assert.equal(outcome.exitCode, 0)
  assert.equal(exitCodeFor({ recoveredCount: 0, failedCount: 0 }), 0)
  assert.equal(outcome.message, '[SessionRecovery] ✓ No orphaned sessions found')
}

console.log('✓ recover-sessions outcome tests passed (4/4)')
