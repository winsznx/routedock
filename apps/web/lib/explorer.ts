// Central helper for stellar.expert explorer URLs and network labels.
//
// stellar.expert names the main network "public" (not "mainnet"), so every
// explorer URL in apps/web must be built here — never inline
// `https://stellar.expert/explorer/${network}` at call sites.
//
// NEXT_PUBLIC_* values are only inlined by Next.js for literal
// `process.env.NEXT_PUBLIC_...` reads, so configuredNetwork() reads the
// variable at call time with that exact literal access.

export type ExplorerKind = 'tx' | 'account' | 'contract'

/** Network the deployment is configured for; testnet unless explicitly mainnet. */
export function configuredNetwork(): 'mainnet' | 'testnet' {
  return process.env.NEXT_PUBLIC_STELLAR_NETWORK === 'mainnet' ? 'mainnet' : 'testnet'
}

/**
 * Resolve a raw network value to the network part of the explorer path.
 * Any unknown value (undefined, '' , 'mainnet', 'futurenet', ...) falls back
 * to the configured network; 'mainnet' maps to stellar.expert's "public".
 */
function resolveNetwork(network?: string): 'mainnet' | 'testnet' {
  if (network === 'mainnet') return 'mainnet'
  if (network === 'testnet') return 'testnet'
  return configuredNetwork()
}

/** Explorer home for a network, e.g. https://stellar.expert/explorer/public. */
export function explorerHome(network?: string): string {
  return `https://stellar.expert/explorer/${resolveNetwork(network) === 'mainnet' ? 'public' : 'testnet'}`
}

/** Full explorer URL for a tx/account/contract, e.g. .../public/tx/abc. */
export function explorerUrl(network: string | undefined, kind: ExplorerKind, id: string): string {
  return `${explorerHome(network)}/${kind}/${id}`
}

/** Human label for a network, resolved the same way as explorerHome. */
export function networkLabel(network?: string): 'Mainnet' | 'Testnet' {
  return resolveNetwork(network) === 'mainnet' ? 'Mainnet' : 'Testnet'
}
