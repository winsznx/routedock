/**
 * USDC conversion — canonical implementation lives in @routedock/nulth-sdk and is
 * re-exported here so SDK consumers (client, provider) share one converter.
 *
 * @routedock/routedock already depends on @routedock/nulth-sdk, so re-exporting
 * (rather than defining a parallel helper) keeps a single source of truth.
 */
import { usdcToStroops, USDC_DECIMALS } from '@routedock/nulth-sdk'
export { usdcToStroops, USDC_DECIMALS }

/** Canonical Circle USDC issuers keyed by Stellar network. */
export const USDC_ISSUERS = {
  testnet: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  mainnet: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
} as const

/**
 * @deprecated Use {@link usdcToStroops} — the same validated bigint converter.
 * Kept as a thin alias so existing call sites keep working during migration.
 */
export const usdcToUnits = usdcToStroops
