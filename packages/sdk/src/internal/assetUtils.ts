import type { RouteDockManifest, AssetConfig, PaymentMode } from '../types.js'
import { RouteDockManifestError } from '../errors.js'

/**
 * Normalizes a manifest to always have an assets array.
 * Handles backward compatibility with root asset/asset_contract fields.
 */
export function normalizeManifestAssets(manifest: RouteDockManifest): AssetConfig[] {
  if (manifest.assets && manifest.assets.length > 0) {
    return manifest.assets
  }

  if (manifest.asset && manifest.asset_contract) {
    return [
      {
        asset: manifest.asset,
        asset_contract: manifest.asset_contract,
      },
    ]
  }

  throw new RouteDockManifestError(
    'Manifest must define either assets[] or root asset/asset_contract fields',
  )
}

/**
 * Finds eligible assets for a given mode and optional endpoint.
 * Returns all assets that match the criteria.
 */
export function getEligibleAssets(
  manifest: RouteDockManifest,
  mode: PaymentMode,
  endpoint?: string,
): AssetConfig[] {
  const assets = normalizeManifestAssets(manifest)

  return assets.filter((asset) => {
    // Check mode eligibility
    if (asset.modes && !asset.modes.includes(mode)) {
      return false
    }

    // Check endpoint eligibility
    if (endpoint && asset.endpoints && asset.endpoints.length > 0) {
      const trimmedEndpoint = endpoint.replace(/^\//, '')
      if (asset.endpoints.includes(endpoint) || asset.endpoints.includes(trimmedEndpoint)) {
        return true
      }

      // Check if endpoint matches a descriptor path or key in manifest.endpoints
      if (manifest.endpoints) {
        let pathname = endpoint
        if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
          try {
            pathname = new URL(endpoint).pathname
          } catch {
            // invalid URL, keep endpoint as is
          }
        }
        const trimmedPathname = pathname.replace(/^\//, '')

        // Check if any matching endpoint descriptor matches
        const matchesEndpoint = Object.entries(manifest.endpoints).some(([key, desc]) => {
          const pathMatches =
            desc.path === pathname ||
            desc.path === endpoint ||
            desc.path.replace(/\/+$/, '') === pathname.replace(/\/+$/, '') ||
            desc.path.replace(/^\//, '') === trimmedPathname
          const keyMatches = key === endpoint || key === trimmedEndpoint
          if (pathMatches || keyMatches) {
            return (
              asset.endpoints!.includes(key) ||
              asset.endpoints!.includes(desc.path) ||
              asset.endpoints!.includes(desc.path.replace(/^\//, ''))
            )
          }
          return false
        })

        if (!matchesEndpoint) {
          return false
        }
      } else {
        return false
      }
    }

    return true
  })
}

/**
 * Resolves the asset contract for a mode and optional endpoint.
 * Honors manifest.assets when defined; falls back to explicitContract or root asset_contract.
 */
export function resolveAssetContract(
  manifest: RouteDockManifest,
  mode: PaymentMode,
  endpoint?: string,
  explicitContract?: string,
): string {
  if (manifest.assets && manifest.assets.length > 0) {
    return selectAsset(manifest, mode, endpoint).asset_contract
  }
  return explicitContract ?? selectAsset(manifest, mode, endpoint).asset_contract
}

/**
 * Selects a single asset for payment, given a mode and optional endpoint.
 * Returns the first eligible asset, or throws if none are available.
 */
export function selectAsset(
  manifest: RouteDockManifest,
  mode: PaymentMode,
  endpoint?: string,
): AssetConfig {
  const eligible = getEligibleAssets(manifest, mode, endpoint)

  if (eligible.length === 0) {
    const endpointMsg = endpoint ? ` for endpoint '${endpoint}'` : ''
    throw new RouteDockManifestError(
      `No eligible assets found for mode '${mode}'${endpointMsg}`,
    )
  }

  return eligible[0]!
}

/**
 * Checks if a specific asset (by ticker or contract address) is eligible for a mode/endpoint.
 */
export function isAssetEligible(
  manifest: RouteDockManifest,
  assetIdentifier: string,
  mode: PaymentMode,
  endpoint?: string,
): boolean {
  const eligible = getEligibleAssets(manifest, mode, endpoint)

  return eligible.some(
    (asset) =>
      asset.asset === assetIdentifier || asset.asset_contract === assetIdentifier,
  )
}
