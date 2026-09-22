/**
 * Soroban RPC and Horizon endpoint resolution.
 *
 * Without an override the public Stellar endpoints are used — the same defaults
 * the SDK has always shipped. An override lets an operator point at their own
 * Soroban node, a paid provider, a regional endpoint, or a local/futurenet
 * deployment instead of the rate-limited public instances, which are explicitly
 * not intended as production infrastructure.
 */

export function resolveSorobanRpcUrl(
  network: 'testnet' | 'mainnet',
  override?: string,
): string {
  if (override) return override
  return network === 'testnet'
    ? 'https://soroban-testnet.stellar.org'
    : 'https://soroban.stellar.org'
}

export function resolveHorizonUrl(
  network: 'testnet' | 'mainnet',
  override?: string,
): string {
  if (override) return override
  return network === 'testnet'
    ? 'https://horizon-testnet.stellar.org'
    : 'https://horizon.stellar.org'
}
