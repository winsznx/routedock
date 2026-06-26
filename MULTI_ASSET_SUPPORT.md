# Multi-Asset Support in RouteDock Manifests

## Overview

As of this release, RouteDock manifests support multiple payment assets. This allows providers to accept different cryptocurrencies (e.g., USDC, XLM) for different modes or endpoints.

## Migration from Single Asset

### Before (Deprecated)
```json
{
  "routedock": "1.0",
  "name": "My Provider",
  "asset": "USDC",
  "asset_contract": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  ...
}
```

### After (Recommended)
```json
{
  "routedock": "1.0",
  "name": "My Provider",
  "assets": [
    {
      "asset": "USDC",
      "asset_contract": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"
    }
  ],
  ...
}
```

## Backward Compatibility

The deprecated `asset` and `asset_contract` fields are still supported and will be automatically normalized to `assets[0]`. However, using the new `assets` array is recommended for all new implementations.

## Multi-Asset Examples

### Example 1: Different Assets for Different Modes

A provider accepting USDC for inference endpoints and XLM for data lookups:

```json
{
  "routedock": "1.0",
  "name": "AI + Data Provider",
  "description": "Inference in USDC, data lookups in XLM",
  "modes": ["x402", "mpp-charge"],
  "network": "testnet",
  "assets": [
    {
      "asset": "USDC",
      "asset_contract": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      "modes": ["x402"],
      "endpoints": ["inference"]
    },
    {
      "asset": "XLM",
      "asset_contract": "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
      "modes": ["mpp-charge"],
      "endpoints": ["lookup"]
    }
  ],
  "payee": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  "pricing": {
    "x402": { "amount": "0.01", "per": "request" },
    "mpp-charge": { "amount": "0.0001", "per": "request" }
  },
  "endpoints": {
    "inference": "POST /inference",
    "lookup": "GET /data/lookup"
  },
  "tags": ["ai", "data", "multi-asset"]
}
```

### Example 2: Multiple Assets for the Same Mode

A provider that accepts either USDC or XLM for all endpoints:

```json
{
  "routedock": "1.0",
  "name": "Flexible Payment Provider",
  "description": "Accept USDC or XLM",
  "modes": ["mpp-charge"],
  "network": "testnet",
  "assets": [
    {
      "asset": "USDC",
      "asset_contract": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA"
    },
    {
      "asset": "XLM",
      "asset_contract": "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA"
    }
  ],
  "payee": "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  "pricing": {
    "mpp-charge": { "amount": "0.001", "per": "request" }
  },
  "endpoints": {
    "price": "GET /price"
  },
  "tags": ["price", "multi-currency"]
}
```

## Asset Configuration Schema

Each asset in the `assets` array supports the following fields:

- `asset` (required): Asset ticker symbol (e.g., "USDC", "XLM")
- `asset_contract` (required): Stellar Asset Contract (SAC) address
- `modes` (optional): Array of payment modes this asset supports. If omitted, the asset is available for all manifest modes.
- `endpoints` (optional): Array of endpoint names this asset supports. If omitted, the asset is available for all manifest endpoints.

## SDK Utilities

The RouteDock SDK provides utilities for working with multi-asset manifests:

```typescript
import {
  normalizeManifestAssets,
  getEligibleAssets,
  selectAsset,
  isAssetEligible,
} from '@routedock/routedock'

// Get all assets from a manifest (handles backward compatibility)
const assets = normalizeManifestAssets(manifest)

// Find assets eligible for a specific mode
const eligibleForX402 = getEligibleAssets(manifest, 'x402')

// Select the first eligible asset for a mode/endpoint
const asset = selectAsset(manifest, 'mpp-charge', 'price')

// Check if a specific asset is eligible
const usdcOk = isAssetEligible(manifest, 'USDC', 'x402', 'inference')
```

## Provider Implementation

When using the `routedock()` middleware, you no longer need to pass `asset` and `assetContract` if they're defined in the manifest:

```typescript
// Old way (still supported)
app.use('/price', routedock({
  modes: ['x402'],
  pricing: { x402: '0.001' },
  asset: 'USDC',
  assetContract: USDC_CONTRACT,
  manifest,
  // ... other options
}))

// New way (recommended)
app.use('/price', routedock({
  modes: ['x402'],
  pricing: { x402: '0.001' },
  manifest, // asset contract is read from manifest.assets
  // ... other options
}))
```

The middleware automatically extracts the appropriate asset contract from `manifest.assets[0]`.

## Client-Side Asset Discovery

Agents can now discover which assets a provider accepts before attempting payment:

```typescript
const manifest = await fetchManifest(baseUrl)
const assets = normalizeManifestAssets(manifest)

// Check if the agent has any compatible asset
for (const asset of assets) {
  const balance = await getAgentBalance(asset.asset)
  if (balance > 0) {
    console.log(`Can pay with ${asset.asset}`)
  } else {
    console.log(`Insufficient ${asset.asset} - need to fund or skip this provider`)
  }
}
```

This solves the issue where agents with only XLM couldn't discover that a USDC-only provider was incompatible without triggering a failed payment.

## Schema Version

The manifest schema version remains `"1.0"` with this change. The `assets` field is optional, and the deprecated `asset`/`asset_contract` fields remain valid, ensuring full backward compatibility.
