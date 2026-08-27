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

export const SESSION_RATE = '0.0001'
export const MIN_DEPOSIT = '0.10'
export const REFUND_WAITING_PERIOD_LEDGERS = 17280

export interface ManifestInput {
  network: Network
  payee: string
  assetContract: string
  channelContract: string
}

/**
 * Note on `tags`: the previous manifest advertised `sse` and `realtime`, but
 * the endpoint has never served an event stream. MppSessionClient.stream()
 * issues one HTTP request per voucher and calls resp.json() on each, so a
 * single JSON body per request is the correct shape. The tags were the only
 * inaccurate part and are dropped here; the path is unchanged so existing
 * clients and docs keep working.
 */
export function buildManifest({
  network,
  payee,
  assetContract,
  channelContract,
}: ManifestInput): RouteDockManifest {
  return {
    routedock: '1.0',
    name: 'Stellar DEX Orderbook Stream',
    description: 'Voucher-metered USDC/XLM orderbook snapshots from Stellar Horizon',
    modes: ['mpp-session', 'mpp-session-ws'],
    network,
    asset: 'USDC',
    asset_contract: assetContract,
    payee,
    pricing: {
      'mpp-session': {
        rate: SESSION_RATE,
        per: 'voucher',
        channel_factory: channelContract,
        min_deposit: MIN_DEPOSIT,
        refund_waiting_period_ledgers: REFUND_WAITING_PERIOD_LEDGERS,
      },
      'mpp-session-ws': {
        rate: SESSION_RATE,
        per: 'voucher',
        channel_factory: channelContract,
        min_deposit: MIN_DEPOSIT,
        refund_waiting_period_ledgers: REFUND_WAITING_PERIOD_LEDGERS,
      },
    },
    endpoints: { stream: { method: 'GET', path: '/stream/orderbook' } },
    tags: ['stream', 'stellar', 'dex', 'orderbook', 'usdc', 'websocket'],
    regions: ['FRA', 'SIN'],
    latency_hints: { FRA: 11, SIN: 19 },
    categories: ['data/stream/crypto'],
  }
}
