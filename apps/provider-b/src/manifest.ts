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

export const SESSION_RATE = '0.0001'
export const MIN_DEPOSIT = '0.10'
export const REFUND_WAITING_PERIOD_LEDGERS = 17280

export interface ManifestInput {
  network: Network
  payee: string
  assetContract: string
  /**
   * Default / factory channel contract address advertised in `channel_factory`.
   * Agents may pay through this channel or any per-session channel deployed for
   * the provider's payee and commitment key; `routedockHono` keys session state
   * per channel ID from the verified credential (#550).
   */
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
