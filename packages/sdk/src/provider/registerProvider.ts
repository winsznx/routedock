import type { SupabaseClient } from '@supabase/supabase-js'
import type { RouteDockManifest } from '../types.js'
import { manifestDigest, verifyManifestSignature } from '../manifest/sign.js'
import { bytesToHex } from '../internal/encoding.js'
import { RouteDockManifestError } from '../errors.js'
import { resolveLogger, type RouteDockLogger } from '../internal/logger.js'

/** Default minimum gap between `last_seen_at` refreshes for an unchanged manifest. */
export const DEFAULT_REGISTRATION_TOUCH_INTERVAL_MS = 60 * 60 * 1000

export interface RegisterProviderOptions {
  supabase: SupabaseClient
  manifest: RouteDockManifest & { signature?: string; signature_version?: string }
  baseUrl: string
  /**
   * Minimum time between `last_seen_at` refreshes when the stored manifest
   * digest already matches. Within this window an unchanged re-registration
   * performs no write at all. Defaults to one hour.
   */
  touchIntervalMs?: number
  /** Log sink for the deprecation warning. Defaults to a console-backed logger. */
  logger?: RouteDockLogger
  /**
   * @deprecated Ignored. A provider can no longer mark itself verified: the
   * `verified` column is only ever changed by an operator (database admin
   * role). Accepted for one release so existing callers keep compiling; a
   * warning is logged and the value is discarded.
   */
  verified?: boolean
}

let warnedVerifiedIgnored = false

function warnVerifiedIgnored(logger: RouteDockLogger): void {
  if (warnedVerifiedIgnored) return
  warnedVerifiedIgnored = true
  logger(
    'warn',
    '[routedock] registerProvider: the `verified` option is deprecated and ignored. ' +
      'Providers cannot mark themselves verified; an operator sets providers.verified.',
  )
}

/**
 * Register a provider in the Supabase `providers` table.
 *
 * Verifies the manifest's Ed25519 signature before writing to the database
 * keyed on `base_url`.
 *
 * The `verified` column is never part of the payload: new rows take the column
 * default (false) and existing rows keep whatever an operator set. If the
 * stored `manifest_digest` already matches, no row is rewritten; `last_seen_at`
 * is refreshed at most once per `touchIntervalMs`.
 *
 * Throws `RouteDockSignatureError` if the manifest is unsigned or invalid,
 * and `Error` if the database write fails.
 */
export async function registerProvider(
  optionsOrSupabase: RegisterProviderOptions | SupabaseClient,
  manifestArg?: RouteDockManifest & { signature?: string },
  baseUrlArg?: string,
  verifiedArg?: boolean,
): Promise<void> {
  let supabase: SupabaseClient
  let manifest: RouteDockManifest & { signature?: string }
  let baseUrl: string
  let touchIntervalMs = DEFAULT_REGISTRATION_TOUCH_INTERVAL_MS
  let verifiedPassed: boolean
  let logger: RouteDockLogger | undefined

  if ('supabase' in optionsOrSupabase) {
    supabase = optionsOrSupabase.supabase
    manifest = optionsOrSupabase.manifest
    baseUrl = optionsOrSupabase.baseUrl
    touchIntervalMs = optionsOrSupabase.touchIntervalMs ?? touchIntervalMs
    verifiedPassed = optionsOrSupabase.verified !== undefined
    logger = optionsOrSupabase.logger
  } else {
    supabase = optionsOrSupabase
    if (!manifestArg || !baseUrlArg) {
      throw new RouteDockManifestError('manifest and baseUrl are required for registerProvider')
    }
    manifest = manifestArg
    baseUrl = baseUrlArg
    verifiedPassed = verifiedArg !== undefined
  }

  if (verifiedPassed) warnVerifiedIgnored(resolveLogger(logger))

  // Mandatory signature check before registering into Supabase
  verifyManifestSignature(manifest)

  const normalizedBaseUrl = baseUrl.replace(/\/$/, '')
  const digest = bytesToHex(manifestDigest(manifest))
  const now = new Date()

  const { data: existing, error: readError } = await supabase
    .from('providers')
    .select('manifest_digest, last_seen_at')
    .eq('base_url', normalizedBaseUrl)
    .maybeSingle()

  if (!readError && existing && existing.manifest_digest === digest) {
    const lastSeen = Date.parse(String(existing.last_seen_at))
    if (Number.isFinite(lastSeen) && now.getTime() - lastSeen < touchIntervalMs) {
      return
    }

    const { error: touchError } = await supabase
      .from('providers')
      .update({ last_seen_at: now.toISOString() })
      .eq('base_url', normalizedBaseUrl)

    if (touchError) {
      throw new Error(`Failed to register provider in Supabase: ${touchError.message}`)
    }
    return
  }

  // `verified` and `first_registered_at` are deliberately absent: an insert
  // takes the column defaults, and an update never touches them.
  const { error } = await supabase.from('providers').upsert(
    {
      name: manifest.name,
      description: manifest.description ?? null,
      base_url: normalizedBaseUrl,
      modes: manifest.modes,
      tags: manifest.tags ?? [],
      categories: manifest.categories ?? [],
      network: manifest.network,
      payee: manifest.payee,
      manifest: manifest as unknown as Record<string, unknown>,
      manifest_digest: digest,
      last_seen_at: now.toISOString(),
    },
    { onConflict: 'base_url' },
  )

  if (error) {
    throw new Error(`Failed to register provider in Supabase: ${error.message}`)
  }
}
