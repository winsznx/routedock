import { useEffect, useMemo, useRef } from 'react'
import { Keypair } from '@stellar/stellar-sdk'
import { RouteDockClient, type RouteDockClientConfig } from '../client/RouteDockClient.js'

/**
 * Returns a memoized RouteDockClient. Re-creates only when wallet / network /
 * spendCap / commitmentSecret / retryPolicy identity changes.
 *
 * The client runs in the browser, so the wallet secret is visible to anyone who
 * loads the page. Never source it from a public environment variable or use a
 * funded key.
 *
 * @example
 * const THROWAWAY_TESTNET_SECRET = 'S...'
 * const client = useRouteDockClient({
 *   wallet: THROWAWAY_TESTNET_SECRET,
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

  // Wipe the previous client's commitment secret when a config change produces a
  // new client instance. There is no unmount cleanup because React StrictMode
  // replays effect cleanups on a still-mounted client, which would wipe the active
  // secret; when the component unmounts, the secret is released with the instance.
  const previous = useRef<RouteDockClient | null>(null)
  useEffect(() => {
    if (previous.current && previous.current !== client) previous.current.dispose()
    previous.current = client
  }, [client])

  return client
}
