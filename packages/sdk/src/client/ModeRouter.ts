import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import type { RouteDockManifest, PaymentMode } from '../types.js'
import {
  RouteDockError,
  RouteDockManifestError,
  RouteDockManifestTimeoutError,
  RouteDockNoSupportedModeError,
  RouteDockClientVersionError,
  httpStatusToError,
  wrapFetchError,
} from '../errors.js'
import { withRetry, type RetryPolicy } from '../internal/retry.js'
import schema from '../schemas/routedock.schema.json' assert { type: 'json' }
import pkg from '../../package.json' assert { type: 'json' }
import { verifyManifestSignature } from '../manifest/sign.js'

const ajv = new Ajv()
addFormats(ajv)
const validateManifest = ajv.compile(schema)

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
  /** Prefer the lowest-cost supported per-request mode when set to 'cost'. */
  optimize?: 'cost' | 'reliability' | 'latency'
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

/** Fetch, validate, and cache a RouteDock manifest from `baseUrl`. */
export async function fetchManifest(
  baseUrl: string,
  retryPolicy?: RetryPolicy,
  manifestTimeoutMs = DEFAULT_MANIFEST_TIMEOUT_MS,
): Promise<RouteDockManifest> {
  const cached = manifestCache.get(baseUrl)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    assertClientVersionSupported(cached.manifest, baseUrl)
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

    if (!validateManifest(raw)) {
      const msgs = ajv.errorsText(validateManifest.errors)
      throw new RouteDockManifestError(`Invalid manifest at ${url}: ${msgs}`)
    }

    const manifest = raw as unknown as RouteDockManifest
    verifyManifestSignature(manifest)
    assertClientVersionSupported(manifest, baseUrl)
    manifestCache.set(baseUrl, { manifest, fetchedAt: Date.now() })
    return manifest
  }, retryPolicy)
}

/**
 * Deterministic mode selection per Section 6.3 of ROUTEDOCK_MASTER.md.
 *
 * By default, a provider that supports mpp-charge is preferred over x402.
 * If { optimize: 'cost' } is provided, the supported per-request mode with the
 * lowest declared amount is selected instead, optionally respecting a
 * budget_per_request cap.
 */
export function selectMode(
  manifest: RouteDockManifest,
  options: ModeSelectOptions = {},
): PaymentMode {
  const modes = manifest.modes
  const log = options.logger ?? (() => {})

  if (options.forceMode) {
    if (!modes.includes(options.forceMode)) {
      throw new RouteDockNoSupportedModeError(
        `Provider does not support forced mode: ${options.forceMode} (available: ${modes.join(', ')})`,
      )
    }
    log(`[RouteDock] ${manifest.name} → ${options.forceMode} (forced)`)
    return options.forceMode
  }

  if ((options.sustained || options.session) && modes.includes('mpp-session')) {
    const mode: PaymentMode = 'mpp-session'
    log(`[RouteDock] ${manifest.name} → ${mode}`)
    return mode
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
        log(`[RouteDock] ${manifest.name} → ${cheapestCandidate.mode} (cost-optimized)`)
        return cheapestCandidate.mode
      }
    }
  }

  if (modes.includes('mpp-charge')) {
    const mode: PaymentMode = 'mpp-charge'
    log(`[RouteDock] ${manifest.name} → ${mode}`)
    return mode
  }

  if (modes.includes('x402')) {
    const mode: PaymentMode = 'x402'
    log(`[RouteDock] ${manifest.name} → ${mode}`)
    return mode
  }

  throw new RouteDockNoSupportedModeError(
    `No supported payment mode found in manifest (modes: ${modes.join(', ')})`,
  )
}
