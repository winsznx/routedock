export interface RecoveryStats {
  recoveredCount: number
  failedCount: number
}

/** A partial recovery is a failed run even when some sessions succeeded. */
export function exitCodeFor(stats: RecoveryStats): 0 | 1 {
  return stats.failedCount > 0 ? 1 : 0
}
