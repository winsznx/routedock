import type { RouteDockManifest } from '@routedock/routedock'

export const TESTNET_USDC_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'

export const USDC_ISSUERS = {
  testnet: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  mainnet: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
} as const

export const HORIZON_URLS = {
  testnet: 'https://horizon-testnet.stellar.org',
  mainnet: 'https://horizon.stellar.org',
} as const

export type Network = keyof typeof USDC_ISSUERS

export const X402_PRICE = '0.001'
export const MPP_CHARGE_PRICE = '0.0008'

export interface ManifestInput {
  network: Network
  payee: string
  assetContract: string
}

export function buildManifest({ network, payee, assetContract }: ManifestInput): RouteDockManifest {
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
        facilitator: `https://channels.openzeppelin.com/x402${network === 'mainnet' ? '' : '/testnet'}`,
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
