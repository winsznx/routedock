/**
 * Exit-code decision for the session recovery CLI.
 *
 * Split out of `recover-sessions.ts` so the decision can be tested without
 * importing a module that calls `process.exit` as soon as it loads.
 */

import type { ReconciliationStats } from '@routedock/routedock/provider'

/**
 * The parts of a recovery run's stats that decide the exit code.
 *
 * `recoveredCount` is carried in the type even though the decision below does
 * not read it: a run that also recovered channels is exactly the case that used
 * to be reported as a success, so the signature should make callers pass it.
 */
export type RecoveryOutcome = Pick<ReconciliationStats, 'recoveredCount' | 'failedCount'>

/**
 * Map a recovery run's outcome to a process exit code.
 *
 * Any channel that failed makes the whole run a failure, even when other
 * channels were recovered. Anything that gates on this exit code — a shell
 * wrapper, a cron job, a CI step — must not read a partial failure as success:
 * a channel that failed to settle stays in `closing`, which means provider
 * revenue that was never collected.
 *
 * `skippedCount` deliberately plays no part. A session skipped for incomplete
 * data is not a failed settlement.
 */
export function exitCodeFor(stats: RecoveryOutcome): 0 | 1 {
  return stats.failedCount > 0 ? 1 : 0
}
