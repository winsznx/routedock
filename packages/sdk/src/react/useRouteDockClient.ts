import { useEffect, useMemo } from 'react'
import { Keypair } from '@stellar/stellar-sdk'
import { RouteDockClient, type RouteDockClientConfig } from '../client/RouteDockClient.js'

/**
 * Returns a memoized RouteDockClient. Re-creates the client only when a config
 * field actually changes: `wallet`, `network`, `spendCap` (including normalized
 * and sorted `endpointCaps`), `commitmentSecret`, `retryPolicy`, `preSignHook`,
 * `spendStore`, `logger`, `manifestTimeoutMs`, `expectedPayee`, and `vault`.
 * Scalar fields are compared by value, so rendering with a fresh but
 * structurally equal config object reuses the existing client.
 *
 * Function and store fields (`preSignHook`, `spendStore`, `logger`,
 * `retryPolicy.onRetry`, `retryPolicy.logger`) are keyed by identity: memoize
 * them in the caller or the client will be rebuilt on every render.
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
  const spendCapKey = serializeSpendCap(config.spendCap)
  const retryKey = serializeRetryPolicy(config.retryPolicy)
  const vaultKey = serializeVault(config.vault)

  const client = useMemo(
    () => new RouteDockClient(config),
    // Every config field is represented below; adding `config` itself would
    // rebuild the client on every render and defeat the memoization.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      walletKey,
      config.network,
      spendCapKey,
      config.commitmentSecret,
      retryKey,
      config.preSignHook,
      config.spendStore,
      config.logger,
      config.manifestTimeoutMs,
      config.expectedPayee,
      vaultKey,
      config.retryPolicy?.onRetry,
      config.retryPolicy?.logger,
    ],
  )

  // Dispose the commitment secret when the client instance is replaced or the
  // component unmounts, so the secret does not linger in the WeakMap.
  useEffect(() => () => client.dispose(), [client])

  return client
}

function serializeSpendCap(spendCap: RouteDockClientConfig['spendCap']): string {
  if (!spendCap) return ''
  const endpointCaps = Object.entries(spendCap.endpointCaps ?? {})
    .map(([key, cap]) => {
      let origin = key
      try {
        origin = new URL(key).origin
      } catch {
        origin = key
      }
      return { origin, cap }
    })
    .sort((a, b) => (a.origin < b.origin ? -1 : a.origin > b.origin ? 1 : 0))
  return JSON.stringify([spendCap.daily, spendCap.asset, endpointCaps])
}

function serializeRetryPolicy(policy: RouteDockClientConfig['retryPolicy']): string {
  if (!policy) return ''
  return JSON.stringify([policy.maxAttempts, policy.baseDelayMs, policy.maxDelayMs])
}

function serializeVault(vault: RouteDockClientConfig['vault']): string {
  if (!vault) return ''
  return JSON.stringify([
    vault.mode,
    vault.nulthAccount,
    vault.prover,
    vault.witnessSecret,
    vault.allowedPayees,
    vault.dailyCapUsdc,
    vault.expiryLedger,
    vault.verifierContract,
  ])
}
