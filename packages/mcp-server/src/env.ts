import path from 'node:path'
import os from 'node:os'
import pkg from '../package.json' with { type: 'json' }

export const SERVER_NAME = '@routedock/mcp-server'
export const SERVER_VERSION = pkg.version

export type StellarNetwork = 'testnet' | 'mainnet'

export interface McpEnvConfig {
  stellarSecret: string
  stellarNetwork: StellarNetwork
  commitmentSecret?: string | undefined
  supabaseUrl?: string | undefined
  supabaseKey?: string | undefined
  routedockDailyCap: string
  spendStorePath: string
}

export interface ParseEnvOptions {
  warn?: (msg: string) => void
}

/**
 * Validates and normalizes the STELLAR_NETWORK environment variable.
 * Accepts 'testnet' and 'mainnet'.
 * Maps 'pubnet' and 'public' to 'mainnet' with a warning.
 * Throws an error for any other input.
 */
export function validateStellarNetwork(
  networkInput?: string,
  warn: (msg: string) => void = console.warn
): StellarNetwork {
  if (!networkInput || networkInput.trim() === '') {
    return 'testnet'
  }

  const normalized = networkInput.trim().toLowerCase()
  if (normalized === 'testnet') {
    return 'testnet'
  }
  if (normalized === 'mainnet') {
    return 'mainnet'
  }
  if (normalized === 'pubnet' || normalized === 'public') {
    warn(`WARNING: STELLAR_NETWORK='${networkInput}' is an alias for 'mainnet'. Using 'mainnet'.`)
    return 'mainnet'
  }

  throw new Error(
    `Invalid STELLAR_NETWORK "${networkInput}". Allowed values: testnet, mainnet (or pubnet/public as alias for mainnet).`
  )
}

/**
 * Parses and validates environment variables for the MCP server.
 */
export function parseEnv(
  env: NodeJS.ProcessEnv = process.env,
  options?: ParseEnvOptions
): McpEnvConfig {
  const warn = options?.warn ?? console.warn

  if (env.SUPABASE_SERVICE_KEY) {
    warn(
      'WARNING: Using SUPABASE_SERVICE_KEY bypasses RLS. Use an anon key for list_providers (anon + public_read_providers RLS is sufficient).'
    )
  }

  const stellarSecret = env.STELLAR_SECRET || env.ROUTEDOCK_WALLET_SECRET
  if (!stellarSecret) {
    throw new Error('STELLAR_SECRET or ROUTEDOCK_WALLET_SECRET environment variable is required')
  }

  const routedockDailyCap = env.ROUTEDOCK_DAILY_CAP
  if (!routedockDailyCap) {
    throw new Error('ROUTEDOCK_DAILY_CAP environment variable is required to prevent unbounded spending')
  }

  const stellarNetwork = validateStellarNetwork(env.STELLAR_NETWORK, warn)
  const commitmentSecret = env.COMMITMENT_SECRET
  const supabaseUrl = env.SUPABASE_URL
  const supabaseKey = env.SUPABASE_KEY || env.SUPABASE_SERVICE_KEY
  const spendStorePath =
    env.ROUTEDOCK_SPEND_STORE_PATH || path.join(os.homedir(), '.routedock', 'spend.json')

  return {
    stellarSecret,
    stellarNetwork,
    commitmentSecret,
    supabaseUrl,
    supabaseKey,
    routedockDailyCap,
    spendStorePath,
  }
}
