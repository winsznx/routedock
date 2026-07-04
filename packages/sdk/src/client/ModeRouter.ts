import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import type { RouteDockManifest, PaymentMode } from '../types.js'
import {
  RouteDockError,
  RouteDockManifestError,
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

// ... (unchanged: CacheEntry, LruCache, manifestCache, configureManifestCache,
//      RouteDockLogger, parseMajorMinor, isVersionBelow, assertClientVersionSupported,
//      ModeSelectOptions all stay exactly as in the fix/manifest-versioning-50 branch)

export async function fetchManifest(
  baseUrl: string,
  retryPolicy?: RetryPolicy,
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
      const resp = await fetch(url)
      if (!resp.ok) {
        if (resp.status >= 500 || resp.status === 429 || resp.status === 503) {
          throw httpStatusToError(
            'Manifest fetch failed: HTTP ' + resp.status + ' from ' + url,
            resp.status,
            resp,
          )
        }
        throw new RouteDockManifestError(
          'Manifest fetch failed: HTTP ' + resp.status + ' from ' + url,
        )
      }
      raw = await resp.json()
    } catch (err) {
      if (err instanceof RouteDockError) throw err
      throw wrapFetchError(err, 'Manifest fetch error from ' + url)
    }

    if (!validateManifest(raw)) {
      const msgs = ajv.errorsText(validateManifest.errors)
      throw new RouteDockManifestError('Invalid manifest at ' + url + ': ' + msgs)
    }

    const manifest = raw as unknown as RouteDockManifest
    verifyManifestSignature(manifest)
    assertClientVersionSupported(manifest, baseUrl)
    manifestCache.set(baseUrl, { manifest, fetchedAt: Date.now() })
    return manifest
  }, retryPolicy)
}

// ... selectMode unchanged