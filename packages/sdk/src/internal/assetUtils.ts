import type { RouteDockManifest, AssetConfig, PaymentMode } from '../types.js'
import { RouteDockManifestError } from '../errors.js'

/**
 * Normalizes a manifest to always have an assets array.
 * Handles backward compatibility with deprecated asset/asset_contract fields.
 */
export function normalizeManifestAssets(manifest: RouteDockManifest): AssetConfig[] {
  // If assets array exists, use it
  if (manifest.assets && manifest.assets.length > 0) {
    return manifest.assets
  }

  // Fallback to deprecated fields
  if (manifest.asset && manifest.asset_contract) {
    return [
      {
        asset: manifest.asset,
        asset_contract: manifest.asset_contract,
      },
    ]
  }

  throw new RouteDockManifestError(
    'Manifest must define either assets[] or deprecated asset/asset_contract fields',
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
    if (endpoint && asset.endpoints && !asset.endpoints.includes(endpoint)) {
      return false
    }

    return true
  })
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
    const modeMsg = mode
    const endpointMsg = endpoint ? ` for endpoint '${endpoint}'` : ''
    throw new RouteDockManifestError(
      `No eligible assets found for mode '${modeMsg}'${endpointMsg}`,
    )
  }

  // Return first eligible asset (providers should list preferred assets first)
  return eligible[0]
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
