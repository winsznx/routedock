import Ajv from 'ajv'
import type { RouteDockManifest, PaymentMode } from '../types.js'
import { RouteDockManifestError, RouteDockNoSupportedModeError } from '../types.js'
import schema from '../schemas/routedock.schema.json' assert { type: 'json' }

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

/** Fetch, validate, and cache a RouteDock manifest from `baseUrl`. */
export async function fetchManifest(baseUrl: string): Promise<RouteDockManifest> {
  const cached = manifestCache.get(baseUrl)
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.manifest
  }

  const url = baseUrl.replace(/\/$/, '') + '/.well-known/routedock.json'
  let raw: unknown
  try {
    const resp = await fetch(url)
    if (!resp.ok) {
      throw new RouteDockManifestError(`Manifest fetch failed: HTTP ${resp.status} from ${url}`)
    }
    raw = await resp.json()
  } catch (err) {
    if (err instanceof RouteDockManifestError) throw err
    throw new RouteDockManifestError(`Manifest fetch error: ${String(err)}`)
  }

  if (!validateManifest(raw)) {
    const msgs = ajv.errorsText(validateManifest.errors)
    throw new RouteDockManifestError(`Invalid manifest at ${url}: ${msgs}`)
  }

  const manifest = raw as unknown as RouteDockManifest
  manifestCache.set(baseUrl, { manifest, fetchedAt: Date.now() })
  return manifest
}

/**
 * Deterministic mode selection per Section 6.3 of ROUTEDOCK_MASTER.md:
 * 1. If { sustained | session } AND manifest supports mpp-session → mpp-session
 * 2. Else if manifest supports mpp-charge AND network is Stellar → mpp-charge
 * 3. Else if manifest supports x402 → x402
 * 4. Else throw RouteDockNoSupportedModeError
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
    console.log(`[RouteDock] ${manifest.name} → ${options.forceMode} (forced)`)
    return options.forceMode
  }

  if ((options.sustained || options.session) && modes.includes('mpp-session')) {
    const mode: PaymentMode = 'mpp-session'
    console.log(`[RouteDock] ${manifest.name} → ${mode}`)
    return mode
  }

  if (modes.includes('mpp-charge')) {
    const mode: PaymentMode = 'mpp-charge'
    console.log(`[RouteDock] ${manifest.name} → ${mode}`)
    return mode
  }

  if (modes.includes('x402')) {
    const mode: PaymentMode = 'x402'
    console.log(`[RouteDock] ${manifest.name} → ${mode}`)
    return mode
  }

  throw new RouteDockNoSupportedModeError(
    `No supported payment mode found in manifest (modes: ${modes.join(', ')})`,
  )
}
