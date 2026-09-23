import { useEffect, useMemo, useRef } from 'react'
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

  const client = useMemo(
    () => new RouteDockClient(config),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [walletKey, config.network, spendCapKey, config.commitmentSecret, retryKey],
  )

  // Dispose the previous client's secret when configuration changes. There is
  // intentionally no unmount cleanup: StrictMode replays effect cleanups on a
  // still-mounted client, while the WeakMap releases secrets with the instance.
  const previous = useRef<RouteDockClient | null>(null)
  useEffect(() => {
    if (previous.current && previous.current !== client) previous.current.dispose()
    previous.current = client
  }, [client])

  return client
}
