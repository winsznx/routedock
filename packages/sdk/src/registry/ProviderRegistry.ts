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
    /**
     * Per-account timeout for on-chain account loads, in milliseconds.
     * Defaults to 10000 ms.
     */
    timeoutMs?: number
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

export interface SearchProvidersOptions {
  /** Maximum number of results. Defaults to 20; the registry clamps it to 1..50. */
  limit?: number
  /** Also return providers that have not been verified. Defaults to false. */
  includeUnverified?: boolean
}

function mapSupabaseRow(r: SupabaseProviderRow): ProviderRecord {
  return {
    name: r.name,
    description: r.description ?? undefined,
    base_url: r.base_url,
    modes: r.modes,
    tags: r.tags,
    network: r.network,
    payee: r.payee,
    source: 'supabase' as const,
    verified: r.verified === true,
  }
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
      ...(config.onChain.timeoutMs !== undefined ? { timeoutMs: config.onChain.timeoutMs } : {}),
    })
  }

  async listProviders(): Promise<ProviderRecord[]> {
    const supabaseProviders = await this.trySupabase()
    if (supabaseProviders.length > 0) return supabaseProviders

    return this.tryOnChain()
  }

  /**
   * Find providers by free-text capability, e.g. "streaming price feed".
   *
   * Calls the `search_providers` SQL function (migration 007), which ranks
   * providers by trigram similarity of their name and description and boosts
   * exact tag matches. When Supabase is not configured or the call fails, it
   * falls back to the on-chain registry, keeping providers whose tags contain
   * one of the query's words or whose endpoint contains the query. A Supabase
   * call that succeeds with no matches returns an empty list.
   */
  async searchProviders(
    query: string,
    options: SearchProvidersOptions = {},
  ): Promise<ProviderRecord[]> {
    const text = query.trim()
    if (!text) return []

    const limit = options.limit ?? 20
    const viaSupabase = await this.trySupabaseSearch(text, limit, options.includeUnverified === true)
    if (viaSupabase) return viaSupabase

    return this.searchOnChain(text, limit)
  }

  private async trySupabaseSearch(
    query: string,
    limit: number,
    includeUnverified: boolean,
  ): Promise<ProviderRecord[] | null> {
    if (!this.supabase) return null
    try {
      const { data, error } = await this.supabase.rpc('search_providers', {
        query,
        network: this.network,
        verified_only: !includeUnverified,
        max_results: limit,
      })
      if (error || !Array.isArray(data)) return null
      return (data as unknown as SupabaseProviderRow[]).map(mapSupabaseRow)
    } catch {
      return null
    }
  }

  private async searchOnChain(query: string, limit: number): Promise<ProviderRecord[]> {
    const needle = query.toLowerCase()
    const words = needle.split(/\s+/).filter(Boolean)
    const providers = await this.tryOnChain()
    return providers
      .filter(
        (p) =>
          p.tags.some((tag) => words.includes(tag.toLowerCase())) ||
          p.base_url.toLowerCase().includes(needle),
      )
      .slice(0, Math.max(1, Math.min(limit, 50)))
  }

  private async trySupabase(): Promise<ProviderRecord[]> {
    if (!this.supabase) return []
    try {
      const { data, error } = await this.supabase
        .from('providers')
        .select('*')
        .eq('verified', true)
        .eq('network', this.network)
        .limit(100)

      if (error) return []
      if (!data || data.length === 0) return []

      return (data as unknown as SupabaseProviderRow[]).map(mapSupabaseRow)
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
