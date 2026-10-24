import type { RouteDockLogger } from './logger.js'

/**
 * Explicit provider configuration for recording `session_settled` on the
 * agent vault after a clean mpp-session close.
 *
 * This replaced the old `process.env.AGENT_VAULT_CONTRACT` read inside the
 * provider handlers: Workers have no `process.env` without `nodejs_compat`,
 * and the docs told operators to set `AGENT_VAULT_CONTRACT_ID`, which the SDK
 * never read. Passing the contract in as an option works on every runtime.
 */
export interface VaultSettlementConfig {
  /** Agent vault contract id (C...) whose `record_session_settlement` entry point records the session. */
  contract: string
  /** Soroban RPC endpoint override; defaults to the public endpoint for the configured network. */
  rpcUrl?: string
}

/**
 * Resolve the vault settlement configuration from the explicit option,
 * falling back to the legacy env vars for one release.
 *
 * The option always wins. When it is unset, `AGENT_VAULT_CONTRACT` (the name
 * the SDK used to read) and `AGENT_VAULT_CONTRACT_ID` (the name the docs have
 * always told operators to set) are both honoured with a deprecation warning,
 * so no deployment silently stops recording vault settlements. The fallback
 * lives outside `provider/` deliberately — the adapters themselves only ever
 * read their options.
 */
export function resolveVaultSettlementConfig(
  option: VaultSettlementConfig | undefined,
  logger: RouteDockLogger,
): VaultSettlementConfig | undefined {
  if (option) return option
  // Workers without nodejs_compat have no `process` at all — the fallback is
  // simply unavailable there, which is why the option is the real interface.
  if (typeof process === 'undefined') return undefined
  const fromEnv = process.env.AGENT_VAULT_CONTRACT ?? process.env.AGENT_VAULT_CONTRACT_ID
  if (!fromEnv) return undefined
  logger(
    'warn',
    '[vault] configuring the vault contract via the AGENT_VAULT_CONTRACT/AGENT_VAULT_CONTRACT_ID ' +
      'environment variables is deprecated and will be removed in the next minor release — ' +
      'pass the vaultSettlement option instead',
    {},
  )
  return { contract: fromEnv }
}
