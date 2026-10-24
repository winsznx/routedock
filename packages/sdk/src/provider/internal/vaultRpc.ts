import type { Server as SorobanServer } from '@stellar/stellar-sdk/rpc'

/**
 * Construct the Soroban RPC client used for vault session settlement.
 *
 * Kept in its own module for two reasons: the dynamic import keeps the RPC
 * client out of Workers bundles whose providers never record vault
 * settlements, and it gives tests a narrow seam to mock instead of replacing
 * all of `@stellar/stellar-sdk/rpc` — a CJS module whose exports node:test
 * module mocks cannot redefine.
 */
export async function createSorobanRpcServer(rpcUrl: string): Promise<SorobanServer> {
  const { Server } = await import('@stellar/stellar-sdk/rpc')
  return new Server(rpcUrl)
}
