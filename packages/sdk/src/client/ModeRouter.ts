import Ajv from 'ajv'
import type { RouteDockManifest, PaymentMode, EndpointEntry } from '../types.js'
import {
  RouteDockError,
  RouteDockManifestError,
  RouteDockNoSupportedModeError,
  RouteDockDeprecatedError,
  httpStatusToError,
  wrapFetchError,
} from '../errors.js'
import { withRetry, type RetryPolicy } from '../internal/retry.js'
import schema from '../schemas/routedock.schema.json' with { type: 'json' }

const ajv = new Ajv()
const validateManifest = ajv.compile(schema)

interface CacheEntry {
  manifest: RouteDockManifest
  fetchedAt: number
}

const CACHE_TTL_MS = 60_000

/** In-memory manifest cache keyed by base URL. */
const manifestCache = new Map<string, CacheEntry>()

export interface ModeSelectOptions {
  /** Force mpp-session if the provider supports it */
  sustained?: boolean
  session?: boolean
  /**
   * Override mode selection and use this specific mode.
   * Throws RouteDockNoSupportedModeError if the provider does not support it.
   */
  forceMode?: PaymentMode
}

/**
 * Check if a manifest has expired based on its expires_at field.
 * Returns true if the manifest is expired and should be re-fetched.
 */
function isManifestExpired(manifest: RouteDockManifest): boolean {
  if (!manifest.expires_at) return false
  const expiry = Date.parse(manifest.expires_at)
  return !Number.isNaN(expiry) && Date.now() >= expiry
}

/**
 * Normalize an endpoint value (string or EndpointEntry) into a string path.
 */
export function normalizeEndpointPath(
  value: string | EndpointEntry | undefined,
): string | undefined {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && 'path' in value) return (value as EndpointEntry).path
  return undefined
}

/**
 * Get deprecation info for an endpoint value.
 * Returns undefined if not deprecated, otherwise the EndpointEntry metadata.
 */
export function getEndpointDeprecation(
  value: string | EndpointEntry | undefined,
): { deprecated: boolean; sunsetAt: string | undefined } | undefined {
  if (typeof value === 'object' && value && 'deprecated' in value) {
    const entry = value as EndpointEntry
    if (entry.deprecated) {
      return { deprecated: true, sunsetAt: entry.sunset_at }
    }
  }
  return undefined
}

/**
 * Check if a pricing config entry is deprecated.
 * Returns undefined if not deprecated, otherwise the deprecation metadata.
 */
export function getPricingDeprecation(
  pricingEntry: { deprecated?: boolean; sunset_at?: string } | undefined,
): { deprecated: boolean; sunsetAt: string | undefined } | undefined {
  if (pricingEntry?.deprecated) {
    return { deprecated: true, sunsetAt: pricingEntry.sunset_at }
  }
  return undefined
}

/** Fetch, validate, and cache a RouteDock manifest from `baseUrl`. */
export async function fetchManifest(
  baseUrl: string,
  retryPolicy?: RetryPolicy,
): Promise<RouteDockManifest> {
  const cached = manifestCache.get(baseUrl)
  if (cached) {
    // Respect expires_at — if the manifest has expired, force a re-fetch
    if (isManifestExpired(cached.manifest)) {
      manifestCache.delete(baseUrl)
    } else if (Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.manifest
    }
  }

  const url = baseUrl.replace(/\/$/, '') + '/.well-known/routedock.json'

  const manifest = await withRetry(async () => {
    let raw: unknown
    try {
      const resp = await fetch(url)
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
      if (err instanceof RouteDockError) throw err
      throw wrapFetchError(err, `Manifest fetch error from ${url}`)
    }

    if (!validateManifest(raw)) {
      const msgs = ajv.errorsText(validateManifest.errors)
      throw new RouteDockManifestError(`Invalid manifest at ${url}: ${msgs}`)
    }

    return raw as unknown as RouteDockManifest
  }, retryPolicy)

  manifestCache.set(baseUrl, { manifest, fetchedAt: Date.now() })
  return manifest
}

/**
 * Check an endpoint for deprecation status and throw RouteDockDeprecatedError if
 * the endpoint is fully sunset (past its sunset_at date). Log a warning if deprecated
 * but still active.
 */
export function checkEndpointDeprecation(
  endpoints: Record<string, string | EndpointEntry>,
  endpointName: string,
): void {
  const value = endpoints[endpointName]
  const deprecation = getEndpointDeprecation(value)
  if (!deprecation) return

  const sunsetAt = deprecation.sunsetAt
  const isSunset = sunsetAt ? Date.now() >= Date.parse(sunsetAt) : false

  if (isSunset) {
    throw new RouteDockDeprecatedError(
      `Endpoint "${endpointName}" has been sunset (removed as of ${sunsetAt}). ` +
      'Choose a different endpoint or update your manifest cache.',
      endpointName,
      sunsetAt ? { sunsetAt } : undefined,
    )
  }

  // Warn on deprecated but not yet sunset
  const msg = sunsetAt
    ? `Endpoint "${endpointName}" is deprecated. It will be removed after ${sunsetAt}.`
    : `Endpoint "${endpointName}" is deprecated and may be removed in a future release.`
  console.warn(`[RouteDock] ${msg}`)
}

/**
 * Check a pricing mode for deprecation status and throw RouteDockDeprecatedError if
 * the mode is fully sunset. Log a warning if deprecated but still active.
 */
export function checkPricingDeprecation(
  pricing: RouteDockManifest['pricing'],
  mode: PaymentMode,
): void {
  const pricingEntry = pricing[mode]
  const deprecation = getPricingDeprecation(pricingEntry)
  if (!deprecation) return

  const sunsetAt = deprecation.sunsetAt
  const isSunset = sunsetAt ? Date.now() >= Date.parse(sunsetAt) : false

  if (isSunset) {
    throw new RouteDockDeprecatedError(
      `Pricing mode "${mode}" has been sunset (removed as of ${sunsetAt}). ` +
      'Choose a different payment mode or update your manifest cache.',
      mode,
      sunsetAt ? { sunsetAt } : undefined,
    )
  }

  // Warn on deprecated but not yet sunset
  const msg = sunsetAt
    ? `Pricing mode "${mode}" is deprecated. It will be removed after ${sunsetAt}.`
    : `Pricing mode "${mode}" is deprecated and may be removed in a future release.`
  console.warn(`[RouteDock] ${msg}`)
}

/**
 * Deterministic mode selection per Section 6.3 of ROUTEDOCK_MASTER.md:
 * 1. If { sustained | session } AND manifest supports mpp-session → mpp-session
 * 2. Else if manifest supports mpp-charge AND network is Stellar → mpp-charge
 * 3. Else if manifest supports x402 → x402
 * 4. Else throw RouteDockNoSupportedModeError
 *
 * Extended: checks for deprecation on selected mode and throws if sunset.
 */
export function selectMode(
  manifest: RouteDockManifest,
  options: ModeSelectOptions = {},
): PaymentMode {
  const modes = manifest.modes

  if (options.forceMode) {
    if (!modes.includes(options.forceMode)) {
      throw new RouteDockNoSupportedModeError(
        `Provider does not support forced mode: ${options.forceMode} (available: ${modes.join(', ')})`,
      )
    }
    // Check if the forced mode is deprecated/sunset
    checkPricingDeprecation(manifest.pricing, options.forceMode)
    console.log(`[RouteDock] ${manifest.name} → ${options.forceMode} (forced)`)
    return options.forceMode
  }

  if ((options.sustained || options.session) && modes.includes('mpp-session')) {
    const mode: PaymentMode = 'mpp-session'
    checkPricingDeprecation(manifest.pricing, mode)
    console.log(`[RouteDock] ${manifest.name} → ${mode}`)
    return mode
  }

  if (modes.includes('mpp-charge')) {
    const mode: PaymentMode = 'mpp-charge'
    checkPricingDeprecation(manifest.pricing, mode)
    console.log(`[RouteDock] ${manifest.name} → ${mode}`)
    return mode
  }

  if (modes.includes('x402')) {
    const mode: PaymentMode = 'x402'
    checkPricingDeprecation(manifest.pricing, mode)
    console.log(`[RouteDock] ${manifest.name} → ${mode}`)
    return mode
  }

  throw new RouteDockNoSupportedModeError(
    `No supported payment mode found in manifest (modes: ${modes.join(', ')})`,
  )
}