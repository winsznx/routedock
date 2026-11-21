/**
 * Bounded retention for `@stellar/mpp` channel replay-protection keys.
 *
 * The channel verifier writes `stellar:channel:challenge:<id>` for every
 * verified credential and never deletes it. A challenge key only protects
 * while mppx still accepts the challenge (default expiry 5 minutes), so older
 * keys are dead weight. This tracks the keys written through a store and
 * deletes those older than the retention window on each new challenge write.
 * Only challenge keys are ever pruned; voucher records and cumulative keys are
 * never touched.
 */

export const CHALLENGE_KEY_PREFIX = 'stellar:channel:challenge:'

/** mppx challenge expiry (5 min) plus a margin. */
export const DEFAULT_CHALLENGE_RETENTION_MS = 10 * 60 * 1000

export interface ChallengeRetentionOptions {
  /** How long a challenge key is kept after it is written. */
  challengeRetentionMs?: number | undefined
  /** Clock, injectable for tests. */
  now?: (() => number) | undefined
  /** Called when deleting a stale key fails; the key stays tracked. */
  onError?: ((err: unknown, key: string) => void) | undefined
}

export interface ChallengeRetention {
  /** Call after a successful `put`. Records challenge keys and prunes stale ones. */
  afterPut(key: string, remove: (key: string) => Promise<unknown>): Promise<void>
  /** Number of challenge keys currently tracked. */
  size(): number
}

export function createChallengeRetention(opts: ChallengeRetentionOptions = {}): ChallengeRetention {
  const retentionMs = opts.challengeRetentionMs ?? DEFAULT_CHALLENGE_RETENTION_MS
  const now = opts.now ?? Date.now
  // Map preserves insertion order, which is also usedAt order.
  const index = new Map<string, number>()

  return {
    async afterPut(key, remove) {
      if (!key.startsWith(CHALLENGE_KEY_PREFIX)) return
      index.delete(key)
      const t = now()
      index.set(key, t)
      for (const [oldKey, usedAt] of index) {
        if (t - usedAt <= retentionMs) break
        try {
          await remove(oldKey)
          index.delete(oldKey)
        } catch (err) {
          // Keep it tracked and retry on the next put; never fail the voucher.
          opts.onError?.(err, oldKey)
          break
        }
      }
    },
    size: () => index.size,
  }
}
