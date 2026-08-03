import type { SupabaseClient } from '@supabase/supabase-js'
import { OnChainRegistry, type OnChainProviderInfo } from './OnChainRegistry.js'
import { fetchManifest } from '../client/ModeRouter.js'
import type { RouteDockManifest } from '../types.js'

export interface ProviderRecord {
  name: string
  description: string | undefined
  base_url: string
  modes: string[]
  tags: string[]
  network: string
  payee: string
  source: 'supabase' | 'onchain'
  /**
   * True only when the provider was verified out-of-band — for on-chain
   * records the payee is the account that published the endpoint, for
   * supabase records only rows flagged `verified` are returned.
   */
  verified: boolean
}

export interface ProviderRegistryConfig {
  supabase?: SupabaseClient
  onChain: {
    horizonUrl: string
    knownAccounts: string[]
    /**
     * Optional explicit network override. When omitted it is derived from the
     * Horizon URL: URLs containing `testnet` map to 'testnet', everything else
     * defaults to 'mainnet'.
     */
    network?: 'testnet' | 'mainnet'
  }
}

interface SupabaseProviderRow {
  id: string
  name: string
  description: string | null
  base_url: string
  modes: string[]
  tags: string[]
  network: string
  payee: string
  manifest: unknown
  verified: boolean
  registered_at: string
}

export function deriveNetwork(horizonUrl: string): 'testnet' | 'mainnet' {
  return horizonUrl.includes('testnet') ? 'testnet' : 'mainnet'
}

export class ProviderRegistry {
  private readonly supabase: SupabaseClient | undefined
  private readonly onChain: OnChainRegistry
  private readonly network: 'testnet' | 'mainnet'

  constructor(config: ProviderRegistryConfig) {
    this.supabase = config.supabase
    this.network = config.onChain.network ?? deriveNetwork(config.onChain.horizonUrl)
    this.onChain = new OnChainRegistry({
      horizonUrl: config.onChain.horizonUrl,
      knownAccounts: config.onChain.knownAccounts,
    })
  }

  async listProviders(): Promise<ProviderRecord[]> {
    const supabaseProviders = await this.trySupabase()
    if (supabaseProviders.length > 0) return supabaseProviders

    return this.tryOnChain()
  }

  private async trySupabase(): Promise<ProviderRecord[]> {
    if (!this.supabase) return []
    try {
      const { data, error } = await this.supabase
        .from('providers')
        .select('*')
        .eq('verified', true)
        .limit(100)

      if (error) return []
      if (!data || data.length === 0) return []

      return (data as unknown as SupabaseProviderRow[]).map((r) => ({
        name: r.name,
        description: r.description ?? undefined,
        base_url: r.base_url,
        modes: r.modes,
        tags: r.tags,
        network: r.network,
        payee: r.payee,
        source: 'supabase' as const,
        verified: r.verified === true,
      }))
    } catch {
      return []
    }
  }

  private async tryOnChain(): Promise<ProviderRecord[]> {
    const providers = await this.onChain.listProviders()
    return providers.map((p) => ({
      name: `On-chain provider (${p.account.slice(0, 8)}...)`,
      description: `Provider registered on Stellar account ${p.account}`,
      base_url: p.endpoint,
      modes: [],
      tags: p.tags,
      network: this.network,
      payee: p.account,
      source: 'onchain' as const,
      verified: true,
    }))
  }

  /**
   * Fetch a provider's manifest bound to the record's payee. The record's
   * `payee` (from supabase `verified` rows or the on-chain registry account)
   * is the out-of-band trust anchor: the fetched manifest's `payee` must
   * equal it, otherwise `RouteDockSignatureError` is thrown. This closes the
   * gap where the registry never cross-checked the on-chain payee against
   * the manifest payee.
   */
  async fetchProviderManifest(record: ProviderRecord): Promise<RouteDockManifest> {
    const baseUrl = new URL(record.base_url).origin
    return fetchManifest(baseUrl, undefined, undefined, record.payee)
  }
}
