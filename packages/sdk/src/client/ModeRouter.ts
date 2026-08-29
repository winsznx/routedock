import { Validator, type Schema } from '@cfworker/json-schema'
import type { RouteDockManifest, PaymentMode } from '../types.js'
import {
  RouteDockError,
  RouteDockManifestError,
  RouteDockManifestTimeoutError,
  RouteDockManifestSunsetError,
  RouteDockNoSupportedModeError,
  RouteDockPolicyRejectError,
  RouteDockClientVersionError,
  httpStatusToError,
  wrapFetchError,
} from '../errors.js'
import { withRetry, type RetryPolicy } from '../internal/retry.js'
import schema from '../schemas/routedock.schema.json' assert { type: 'json' }
import pkg from '../../package.json' assert { type: 'json' }
import { verifyManifestSignature } from '../manifest/sign.js'

const validator = new Validator(schema as unknown as Schema, '7')

const SDK_VERSION = pkg.version as string

function parseMajorMinor(version: string): [number, number] {
  const parts = version.split('.')
  return [Number.parseInt(parts[0] ?? '0', 10), Number.parseInt(parts[1] ?? '0', 10)]
}

function isVersionBelow(a: string, b: string): boolean {
  const [aMajor, aMinor] = parseMajorMinor(a)
  const [bMajor, bMinor] = parseMajorMinor(b)
  return aMajor < bMajor || (aMajor === bMajor && aMinor < bMinor)
}

function assertClientVersionSupported(manifest: RouteDockManifest, baseUrl: string): void {
  const minVersion = manifest.min_client_version
  if (minVersion && isVersionBelow(SDK_VERSION, minVersion)) {
    throw new RouteDockClientVersionError(
      `SDK version ${SDK_VERSION} is below the minimum required version ${minVersion} for provider at ${baseUrl}. Please upgrade the SDK.`,
    )
  }
}

function assertManifestActive(manifest: RouteDockManifest, baseUrl: string): void {
  const sunsetAt = manifest.sunset_at
  if (!sunsetAt) return

  const sunsetTime = Date.parse(sunsetAt)
  if (!Number.isFinite(sunsetTime)) {
    throw new RouteDockManifestError(
      `Manifest at ${baseUrl} contains an invalid sunset_at timestamp: ${sunsetAt}`,
    )
  }

  if (sunsetTime <= Date.now()) {
    throw new RouteDockManifestSunsetError(
      `Manifest for provider at ${baseUrl} sunset at ${sunsetAt} and can no longer be used`,
    )
  }
}

interface CacheEntry {
  manifest: RouteDockManifest
  fetchedAt: number
}

const CACHE_TTL_MS = 60_000
const DEFAULT_MANIFEST_CACHE_MAX_SIZE = 512
const DEFAULT_MANIFEST_TIMEOUT_MS = 5_000

/**
 * Simple LRU cache backed by Map's insertion-order guarantee.
 * Bounds memory for long-running agents that contact many unique endpoints.
 */
class LruCache<K, V> {
  private map = new Map<K, V>()

  constructor(private maxSize: number) {}

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined
    const value = this.map.get(key) as V
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key)
    } else if (this.map.size >= this.maxSize) {
      const oldestKey = this.map.keys().next().value
      if (oldestKey !== undefined) {
        this.map.delete(oldestKey)
      }
    }
    this.map.set(key, value)
  }

  setMaxSize(maxSize: number): void {
    this.maxSize = maxSize
    while (this.map.size > this.maxSize) {
      const oldestKey = this.map.keys().next().value
      if (oldestKey === undefined) break
      this.map.delete(oldestKey)
    }
  }
}

/** In-memory manifest cache keyed by base URL, bounded to avoid unbounded heap growth. */
const manifestCache = new LruCache<string, CacheEntry>(DEFAULT_MANIFEST_CACHE_MAX_SIZE)

/**
 * Override the manifest cache's max size (default 512). Affects the shared,
 * process-wide cache used by all RouteDockClient instances.
 */
export function configureManifestCache(maxSize: number): void {
  if (!Number.isInteger(maxSize) || maxSize <= 0) {
    throw new RouteDockManifestError('Invalid manifest cache size: ' + maxSize)
  }
  manifestCache.setMaxSize(maxSize)
}

export type RouteDockLogger = (message: string) => void

export interface ModeSelectOptions {
  /** Force mpp-session if the provider supports it */
  sustained?: boolean
  session?: boolean
  /**
   * Preferred streaming transport for sustained sessions. When 'websocket',
   * the mpp-session-ws variant is preferred when the provider advertises it;
   * when 'sse' (or omitted), the classic mpp-session mode is preferred.
   * Either transport falls back to the other session variant when the
   * preferred one is not advertised.
   */
  transport?: 'sse' | 'websocket'
  /** Prefer the lowest-cost supported per-request mode when set to 'cost'. */
  optimize?: 'cost'
  /** Optional maximum acceptable per-request amount for cost-based selection. */
  budget_per_request?: string
  /**
   * Override mode selection and use this specific mode.
   * Throws RouteDockNoSupportedModeError if the provider does not support it.
   */
  forceMode?: PaymentMode
  /** Structured logger for mode selection events. Defaults to no-op. */
  logger?: RouteDockLogger
}

/**
 * Fetch, validate, and cache a RouteDock manifest from `baseUrl`.
 *
 * `expectedPayee`, when provided, is the out-of-band trust anchor for the
 * manifest (e.g. the account this provider registered on-chain): the fetched
 * manifest's `payee` must equal it or `RouteDockSignatureError` is thrown.
 * Callers that obtained a payee from a registry/pinned allowlist MUST pass it;
 * without it the self-signed signature alone proves nothing about who served
 * the manifest.
 */
export async function fetchManifest(
  baseUrl: string,
  retryPolicy?: RetryPolicy,
  manifestTimeoutMs = DEFAULT_MANIFEST_TIMEOUT_MS,
  expectedPayee?: string,
): Promise<RouteDockManifest> {
  const cached = manifestCache.get(baseUrl)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    // Re-assert the trust anchor even on cache hits: the manifest content is
    // immutable, but `expectedPayee` is per-caller, so a caller with a
    // different anchor must still have the binding enforced.
    verifyManifestSignature(cached.manifest, expectedPayee)
    assertClientVersionSupported(cached.manifest, baseUrl)
    assertManifestActive(cached.manifest, baseUrl)
    return cached.manifest
  }

  const url = baseUrl.replace(/\/$/, '') + '/.well-known/routedock.json'

  return withRetry(async () => {
    let raw: unknown
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(manifestTimeoutMs) })
      if (!resp.ok) {
        if (resp.status >= 500 || resp.status === 429 || resp.status === 503) {
          throw httpStatusToError(
            `Manifest fetch failed: HTTP ${resp.status} from ${url}`,
            resp.status,
            resp,
          )
        }
        throw new RouteDockManifestError(
          `Manifest fetch failed: HTTP ${resp.status} from ${url}`,
        )
      }
      raw = await resp.json()
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new RouteDockManifestTimeoutError(
          `Manifest fetch timed out after ${manifestTimeoutMs}ms from ${url}`,
          { cause: err },
        )
      }
      if (err instanceof RouteDockError) throw err
      throw wrapFetchError(err, `Manifest fetch error from ${url}`)
    }

    const result = validator.validate(raw)
    if (!result.valid) {
      const msgs = result.errors.map(err => err.error).join('; ')
      throw new RouteDockManifestError(`Invalid manifest at ${url}: ${msgs}`)
    }

    const manifest = raw as unknown as RouteDockManifest
    verifyManifestSignature(manifest, expectedPayee)
    assertClientVersionSupported(manifest, baseUrl)
    assertManifestActive(manifest, baseUrl)
    manifestCache.set(baseUrl, { manifest, fetchedAt: Date.now() })
    return manifest
  }, retryPolicy)
}

interface ModeSelection {
  mode: PaymentMode
  reason?: 'cost-optimized'
}

function selectFromModes(
  modes: PaymentMode[],
  manifest: RouteDockManifest,
  options: ModeSelectOptions,
): ModeSelection | undefined {
  if (options.sustained || options.session) {
    // Prefer the session variant matching the requested transport, falling
    // back to the other session variant when the preferred one is missing.
    if (options.transport === 'websocket') {
      if (modes.includes('mpp-session-ws')) return { mode: 'mpp-session-ws' }
      if (modes.includes('mpp-session')) return { mode: 'mpp-session' }
    } else {
      if (modes.includes('mpp-session')) return { mode: 'mpp-session' }
      if (modes.includes('mpp-session-ws')) return { mode: 'mpp-session-ws' }
    }
  }

  if (options.optimize === 'cost') {
    const candidates = (['x402', 'mpp-charge'] as Array<'x402' | 'mpp-charge'>)
      .filter((mode) => modes.includes(mode))
      .map((mode) => {
        const pricing = manifest.pricing[mode]
        const amount = pricing?.amount
        const parsedAmount = typeof amount === 'string' ? Number.parseFloat(amount) : Number.NaN
        return {
          mode: mode as PaymentMode,
          amount: Number.isFinite(parsedAmount) ? parsedAmount : Number.POSITIVE_INFINITY,
        }
      })
      .filter((candidate) => Number.isFinite(candidate.amount))

    if (candidates.length > 0) {
      const budget = options.budget_per_request
        ? Number.parseFloat(options.budget_per_request)
        : Number.POSITIVE_INFINITY
      const affordableCandidates = Number.isFinite(budget)
        ? candidates.filter((candidate) => candidate.amount <= budget)
        : candidates

      const cheapestCandidate = [...affordableCandidates].sort((a, b) => a.amount - b.amount)[0]
      if (cheapestCandidate) {
        return { mode: cheapestCandidate.mode, reason: 'cost-optimized' }
      }

      // All candidates exceed the caller's budget ceiling — error instead of
      // silently falling through to an over-budget mode.
      if (options.budget_per_request !== undefined) {
        throw new RouteDockPolicyRejectError('budget_per_request_exceeded')
      }
    }
  }

  if (modes.includes('mpp-charge')) return { mode: 'mpp-charge' }
  if (modes.includes('x402')) return { mode: 'x402' }
  return undefined
}

function logSelection(
  manifest: RouteDockManifest,
  selection: ModeSelection,
  log: RouteDockLogger,
  deprecated: boolean,
): void {
  const reason = selection.reason ? ` (${selection.reason})` : ''
  if (deprecated) {
    log(
      `[RouteDock] WARNING: ${manifest.name} → ${selection.mode}${reason}; selected deprecated mode because no active supported mode is available`,
    )
    return
  }
  log(`[RouteDock] ${manifest.name} → ${selection.mode}${reason}`)
}

/**
 * Deterministic mode selection per Section 6.3 of ROUTEDOCK_MASTER.md.
 *
 * Active modes are always considered before modes listed in `deprecated_modes`.
 * Deprecated modes remain usable as a compatibility fallback and produce a
 * logger warning when selected. An explicit forceMode remains authoritative,
 * but also warns when the forced mode is deprecated.
 */
export function selectMode(
  manifest: RouteDockManifest,
  options: ModeSelectOptions = {},
): PaymentMode {
  const modes = manifest.modes
  const log = options.logger ?? (() => {})
  const deprecatedSet = new Set(manifest.deprecated_modes ?? [])

  if (options.forceMode) {
    if (!modes.includes(options.forceMode)) {
      throw new RouteDockNoSupportedModeError(
        `Provider does not support forced mode: ${options.forceMode} (available: ${modes.join(', ')})`,
      )
    }
    if (deprecatedSet.has(options.forceMode)) {
      log(
        `[RouteDock] WARNING: ${manifest.name} → ${options.forceMode} (forced); selected mode is deprecated`,
      )
    } else {
      log(`[RouteDock] ${manifest.name} → ${options.forceMode} (forced)`)
    }
    return options.forceMode
  }

  const activeModes = modes.filter((mode) => !deprecatedSet.has(mode))
  const deprecatedModes = modes.filter((mode) => deprecatedSet.has(mode))

  const activeSelection = selectFromModes(activeModes, manifest, options)
  if (activeSelection) {
    logSelection(manifest, activeSelection, log, false)
    return activeSelection.mode
  }

  const deprecatedSelection = selectFromModes(deprecatedModes, manifest, options)
  if (deprecatedSelection) {
    logSelection(manifest, deprecatedSelection, log, true)
    return deprecatedSelection.mode
  }

  throw new RouteDockNoSupportedModeError(
    `No supported payment mode found in manifest (modes: ${modes.join(', ')})`,
  )
}
