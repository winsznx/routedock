/** Replay-protection keys written by @stellar/mpp's channel verifier. */
export const CHALLENGE_PREFIX = 'stellar:channel:challenge:'

/** mppx challenge expiry (5 min) plus a margin. */
export const CHALLENGE_RETENTION_MS = 10 * 60 * 1000

/** How often the Durable Object alarm sweeps for stale challenge keys. */
export const CHALLENGE_SWEEP_INTERVAL_MS = 5 * 60 * 1000

export interface ChallengeStorage {
  list(options: { prefix: string }): Promise<Map<string, unknown>>
  delete(keys: string[]): Promise<number>
}

/**
 * Delete challenge keys whose `usedAt` is older than the retention window.
 * Only keys under the challenge prefix are listed, so voucher records and
 * cumulative channel state are never touched. Keys without a readable
 * `usedAt` are left alone. Returns the number of keys deleted.
 */
export async function pruneStaleChallenges(
  storage: ChallengeStorage,
  now: number = Date.now(),
  retentionMs: number = CHALLENGE_RETENTION_MS,
): Promise<number> {
  const entries = await storage.list({ prefix: CHALLENGE_PREFIX })
  const stale: string[] = []
  for (const [key, value] of entries) {
    if (!key.startsWith(CHALLENGE_PREFIX)) continue
    const usedAt = Date.parse((value as { usedAt?: string } | null)?.usedAt ?? '')
    if (Number.isFinite(usedAt) && now - usedAt > retentionMs) stale.push(key)
  }
  // DurableObjectStorage.delete accepts at most 128 keys per call.
  let deleted = 0
  for (let i = 0; i < stale.length; i += 128) {
    deleted += await storage.delete(stale.slice(i, i + 128))
  }
  return deleted
}
