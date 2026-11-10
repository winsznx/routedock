import type { RouteDockManifest } from '@routedock/routedock'
import type { Network } from '@routedock/routedock/network'

// Network constants live in the SDK so provider-a and provider-b cannot
// drift (issue #578). Re-exported here because the app's own modules and
// tests import them from this file.
export {
  TESTNET_USDC_CONTRACT,
  USDC_ISSUERS,
  HORIZON_URLS,
  type Network,
} from '@routedock/routedock/network'

export const X402_PRICE = '0.001'
export const MPP_CHARGE_PRICE = '0.0008'

export interface ManifestInput {
  network: Network
  payee: string
  assetContract: string
  localFacilitator?: boolean
}

export function buildManifest({
  network,
  payee,
  assetContract,
  localFacilitator = false,
}: ManifestInput): RouteDockManifest {
  const facilitator = localFacilitator
    ? 'local'
    : `https://channels.openzeppelin.com/x402${network === 'mainnet' ? '' : '/testnet'}`
  return {
    routedock: '1.0',
    name: 'Stellar DEX Price Feed',
    description: 'Real-time USDC/XLM mid-price from Stellar DEX orderbook via Horizon',
    modes: ['x402', 'mpp-charge'],
    network,
    asset: 'USDC',
    asset_contract: assetContract,
    payee,
    pricing: {
      x402: {
        amount: X402_PRICE,
        per: 'request',
        facilitator,
      },
      'mpp-charge': { amount: MPP_CHARGE_PRICE, per: 'request' },
    },
    endpoints: { price: { method: 'GET', path: '/price' } },
    tags: ['price', 'stellar', 'dex', 'orderbook', 'usdc'],
    regions: ['IAD', 'AMS'],
    latency_hints: { IAD: 14, AMS: 22 },
    categories: ['data/price/crypto'],
  }
}
