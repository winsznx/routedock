import { useMemo } from 'react'
import { Keypair } from '@stellar/stellar-sdk'
import { RouteDockClient, type RouteDockClientConfig } from '../client/RouteDockClient.js'

/**
 * Returns a memoized RouteDockClient. Re-creates only when wallet / network /
 * spendCap / commitmentSecret / retryPolicy identity changes.
 *
 * @example
 * const client = useRouteDockClient({
 *   wallet: process.env.NEXT_PUBLIC_AGENT_SECRET!,
 *   network: 'testnet',
 *   spendCap: { daily: '1.00', asset: 'USDC' },
 * })
 */
export function useRouteDockClient(config: RouteDockClientConfig): RouteDockClient {
  const walletKey =
    typeof config.wallet === 'string' ? config.wallet : (config.wallet as Keypair).secret()
  const spendCapKey = config.spendCap
    ? `${config.spendCap.daily}|${config.spendCap.asset}`
    : ''
  const retryKey = config.retryPolicy
    ? `${config.retryPolicy.maxAttempts}|${config.retryPolicy.baseDelayMs}`
    : ''

  return useMemo(
    () => new RouteDockClient(config),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [walletKey, config.network, spendCapKey, config.commitmentSecret, retryKey],
  )
}
