import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resolveLogger, type RouteDockLogger } from '../internal/logger.js'
import { RouteDockPolicyRejectError } from '../errors.js'
import {
  DEFAULT_SCOPE,
  SPEND_STATE_INVALID,
  describeSpendStateProblem,
  type DailySpend,
  type SpendScope,
  type SpendStore,
} from './SpendStore.js'

/** On-disk format: one {@link DailySpend} per scope. */
interface SpendFile {
  version: 2
  scopes: Record<SpendScope, DailySpend>
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Expand a leading `~` to the home directory and resolve to an absolute path.
 * `fs` does not expand `~` (neither does dotenv), so an unexpanded
 * `~/.routedock/spend.json` would otherwise create a directory literally named
 * `~` under the working directory.
 */
export function resolveSpendFilePath(filePath: string): string {
  const expanded =
    filePath === '~'
      ? os.homedir()
      : filePath.startsWith('~/') || filePath.startsWith('~\\')
        ? path.join(os.homedir(), filePath.slice(2))
        : filePath
  return path.resolve(expanded)
}

/** Tuning for the cross-process lock that guards read-modify-write. */
export interface FileSpendStoreOptions {
  /**
   * A lock file whose mtime is older than this is treated as left behind by a
   * crashed process and broken. A live holder refreshes it, so this only needs
   * to exceed the refresh interval. Default 10 000 ms.
   */
  lockStaleMs?: number
  /**
   * How long to wait for the lock before giving up. A spend cap must fail
   * closed, so a timeout rejects instead of proceeding unlocked. Must be longer
   * than `lockStaleMs` to survive a crashed holder. Default 15 000 ms.
   */
  lockTimeoutMs?: number
  /** Log sink for the one-time legacy-file migration notice. Defaults to the console. */
  logger?: RouteDockLogger
}

const DEFAULT_LOCK_STALE_MS = 10_000
const DEFAULT_LOCK_TIMEOUT_MS = 15_000

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * File-backed durable {@link SpendStore}.
 *
 * Persists the daily spend accumulator to a JSON file on disk, preserving
 * cumulative spending totals across process restarts, crashes, and redeploys.
 *
 * ### Per-scope accounting
 * The file holds one accumulator per {@link SpendScope}
 * (`${network}:${walletPublicKey}:${asset}`, supplied by `RouteDockClient`):
 * `{ "version": 2, "scopes": { "<scope>": { date, totalMicros, endpoints } } }`.
 * Clients on different networks or wallets can share one path and each enforce
 * only their own spend. A file written before scoping existed (a single bare
 * accumulator) is adopted by the first scope that reads it, so today's total is
 * not lost; it is rewritten in the new format on the next update, and a one-time
 * info line is logged.
 *
 * ### Path
 * A leading `~` is expanded with `os.homedir()` and the path is resolved to an
 * absolute one; {@link FileSpendStore.filePath} is the resolved path.
 *
 * ### Error semantics
 * - File absent (ENOENT): returns null — legitimately no spend recorded yet.
 * - File present but unreadable or malformed (invalid JSON, or JSON that is not
 *   a valid spend record: `null`, `{}`, an array, a missing or negative
 *   `totalMicros`, …): throws — a safety control must fail closed, not assume
 *   nothing was spent. A wrong-shape file throws
 *   `RouteDockPolicyRejectError('local_spend_state_invalid')` and is left untouched.
 *
 * ### Write atomicity
 * Writes go to a tmp file that is unique per write (`<filePath>.<pid>.<random>.tmp`),
 * then `fs.rename` onto the target. `rename` is atomic within a filesystem, so
 * there is no window where the target file is truncated but not yet fully
 * written, and two writers can never share (and clobber, or `ENOENT` on) one
 * tmp file.
 *
 * ### Sharing the file between processes
 * `read()` + `write()` alone is not enough when several processes use the same
 * file (the MCP server and the E2E agent both default to
 * `~/.routedock/spend.json`): both can read the same total and both write back
 * `total + amount`. {@link FileSpendStore.update} closes that race — it holds an
 * exclusive lock file (`<filePath>.lock`, created with `O_EXCL`) across the
 * read, the callback and the write, and `RouteDockClient` uses it automatically.
 * `write()` takes the same lock, so every mutation is serialized.
 *
 * The lock is advisory and file-based: it works for processes on one machine
 * (and on filesystems with working `O_EXCL`), not for a file on a flaky network
 * share. A lock whose mtime goes stale (crashed holder) is broken after
 * `lockStaleMs`; a live holder keeps refreshing it. If the lock cannot be
 * acquired within `lockTimeoutMs`, the call rejects — it never proceeds
 * unlocked.
 */
export class FileSpendStore implements SpendStore {
  readonly filePath: string
  private readonly lockPath: string
  private readonly lockStaleMs: number
  private readonly lockTimeoutMs: number
  private readonly logger: RouteDockLogger
  private migrationLogged = false

  constructor(filePath: string, options: FileSpendStoreOptions = {}) {
    this.filePath = resolveSpendFilePath(filePath)
    this.lockPath = `${this.filePath}.lock`
    this.logger = resolveLogger(options.logger)
    this.lockStaleMs = options.lockStaleMs ?? DEFAULT_LOCK_STALE_MS
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS
  }

  async read(scope: SpendScope = DEFAULT_SCOPE): Promise<DailySpend | null> {
    return (await this.readFile(scope)).scopes[scope] ?? null
  }

  /**
   * Read and normalize the file. A legacy single-accumulator file is mapped onto
   * `scope` (the first scope to touch it adopts today's total).
   */
  private async readFile(scope: SpendScope): Promise<SpendFile> {
    let data: string
    try {
      data = await fs.readFile(this.filePath, 'utf-8')
    } catch (err) {
      // ENOENT is expected on first run — no spend recorded yet.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 2, scopes: {} }
      }
      // Any other I/O error (permission denied, EISDIR, etc.) must throw.
      // A cap that cannot read its state should refuse to spend, not assume zero.
      throw new Error(
        `[FileSpendStore] Failed to read spend file at ${this.filePath}: ${(err as Error).message}`,
      )
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      throw new Error(
        `[FileSpendStore] Spend file at ${this.filePath} contains invalid JSON. ` +
          `Delete or repair it before resuming. Raw content: ${data.slice(0, 120)}`,
      )
    }

    if (isRecord(parsed) && parsed['version'] === 2 && isRecord(parsed['scopes'])) {
      const scopes = parsed['scopes']
      for (const [key, value] of Object.entries(scopes)) {
        const problem = describeSpendStateProblem(value)
        if (problem !== null) throw this.invalidState(`record for scope "${key}"`, problem, data)
      }
      return { version: 2, scopes: scopes as Record<SpendScope, DailySpend> }
    }

    // Valid JSON of the wrong shape (null, {}, [], a missing or negative total)
    // must fail closed too: casting it would reset the cap or grow its headroom.
    // Only an absent file (ENOENT above) means zero spend.
    const legacyProblem = describeSpendStateProblem(parsed)
    if (legacyProblem !== null) throw this.invalidState('spend record', legacyProblem, data)

    // Pre-scope file: carry today's total over into the reading client's scope.
    if (!this.migrationLogged) {
      this.migrationLogged = true
      this.logger(
        'info',
        `[FileSpendStore] Migrating pre-scope spend file ${this.filePath} into scope "${scope}"`,
      )
    }
    return { version: 2, scopes: { [scope]: parsed as DailySpend } }
  }

  private invalidState(what: string, problem: string, data: string): RouteDockPolicyRejectError {
    return new RouteDockPolicyRejectError(SPEND_STATE_INVALID, {
      cause: new Error(
        `[FileSpendStore] Spend file at ${this.filePath} does not hold a valid ${what} (${problem}). ` +
          `Delete or repair it before resuming. Raw content: ${data.slice(0, 120)}`,
      ),
    })
  }

  async write(state: DailySpend, scope: SpendScope = DEFAULT_SCOPE): Promise<void> {
    await this.withLock(async (assertHeld) => {
      const file = await this.readFile(scope)
      file.scopes[scope] = state
      await this.writeFile(file, assertHeld)
    })
  }

  /**
   * Atomically read-modify-write the accumulator under the cross-process lock.
   * `fn` receives the current state (or null) and returns the state to persist,
   * or `undefined` to leave the file untouched. If `fn` throws, nothing is
   * written and the lock is released.
   */
  async update(
    fn: (prev: DailySpend | null) => DailySpend | undefined,
    scope: SpendScope = DEFAULT_SCOPE,
  ): Promise<DailySpend | null> {
    return this.withLock(async (assertHeld) => {
      const file = await this.readFile(scope)
      const prev = file.scopes[scope] ?? null
      const next = fn(prev)
      if (next === undefined) return prev
      file.scopes[scope] = next
      await this.writeFile(file, assertHeld)
      return next
    })
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async writeFile(state: SpendFile, assertHeld: () => Promise<void>): Promise<void> {
    const tmpPath = `${this.filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await fs.writeFile(tmpPath, JSON.stringify(state, null, 2), 'utf-8')
      // Last check before the commit point: if our lock was broken as stale
      // (e.g. the process was suspended), refuse to overwrite state another
      // process may have updated since.
      await assertHeld()
      // rename is atomic within a filesystem: the target is either the old
      // content or the new content, never a partial write.
      await fs.rename(tmpPath, this.filePath)
    } catch (err) {
      await fs.rm(tmpPath, { force: true }).catch(() => {})
      throw err
    }
  }

  /** Run `fn` while holding the lock file; always releases it. */
  private async withLock<T>(fn: (assertHeld: () => Promise<void>) => Promise<T>): Promise<T> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })

    const token = `${process.pid}:${randomBytes(8).toString('hex')}`
    await this.acquireLock(token)

    // Keep the lock's mtime fresh so a slow but live holder is never mistaken
    // for a crashed one.
    const heartbeat = setInterval(() => {
      const now = new Date()
      fs.utimes(this.lockPath, now, now).catch(() => {})
    }, Math.max(10, Math.floor(this.lockStaleMs / 3)))
    heartbeat.unref()

    const assertHeld = async (): Promise<void> => {
      let current: string
      try {
        current = await fs.readFile(this.lockPath, 'utf-8')
      } catch {
        current = ''
      }
      if (current !== token) {
        throw new Error(
          `[FileSpendStore] Lost the lock on ${this.lockPath} before committing; ` +
            'refusing to overwrite the spend file. Retry the operation.',
        )
      }
    }

    try {
      return await fn(assertHeld)
    } finally {
      clearInterval(heartbeat)
      await this.releaseLock(token)
    }
  }

  private async acquireLock(token: string): Promise<void> {
    const deadline = Date.now() + this.lockTimeoutMs
    let delay = 5

    for (;;) {
      try {
        const handle = await fs.open(this.lockPath, 'wx')
        try {
          await handle.writeFile(token, 'utf-8')
        } finally {
          await handle.close()
        }
        return
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw new Error(
            `[FileSpendStore] Failed to create lock file ${this.lockPath}: ${(err as Error).message}`,
          )
        }
      }

      await this.breakIfStale()

      if (Date.now() >= deadline) {
        throw new Error(
          `[FileSpendStore] Timed out after ${this.lockTimeoutMs}ms waiting for ${this.lockPath}. ` +
            'Another process is holding the spend file lock; if none is running, delete the lock file.',
        )
      }
      // Jittered exponential backoff, capped so waiters re-check promptly.
      await sleep(delay + Math.floor(Math.random() * delay))
      delay = Math.min(delay * 2, 50)
    }
  }

  /** Remove the lock if its holder stopped refreshing it (crashed process). */
  private async breakIfStale(): Promise<void> {
    let before
    try {
      before = await fs.stat(this.lockPath)
    } catch {
      return // already released
    }
    if (Date.now() - before.mtimeMs <= this.lockStaleMs) return

    // Re-check right before removing so we do not delete a lock that another
    // waiter has just broken and re-acquired.
    try {
      const after = await fs.stat(this.lockPath)
      if (after.ino !== before.ino || after.mtimeMs !== before.mtimeMs) return
      await fs.unlink(this.lockPath)
    } catch {
      // gone, or being handled by someone else
    }
  }

  private async releaseLock(token: string): Promise<void> {
    try {
      // Only remove a lock we still own.
      if ((await fs.readFile(this.lockPath, 'utf-8')) === token) {
        await fs.unlink(this.lockPath)
      }
    } catch {
      // already gone
    }
  }
}
