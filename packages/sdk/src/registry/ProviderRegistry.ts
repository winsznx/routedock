import type { SupabaseClient } from '@supabase/supabase-js'
import { OnChainRegistry, type OnChainProviderInfo } from './OnChainRegistry.js'

export interface ProviderRecord {
  name: string
  description: string | undefined
  base_url: string
  modes: string[]
  tags: string[]
  network: string
  payee: string
  source: 'supabase' | 'onchain'
}

export interface ProviderRegistryConfig {
  supabase?: SupabaseClient
  onChain: {
    horizonUrl: string
    knownAccounts: string[]
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

export class ProviderRegistry {
  private readonly supabase: SupabaseClient | undefined
  private readonly onChain: OnChainRegistry

  constructor(config: ProviderRegistryConfig) {
    this.supabase = config.supabase
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
      network: 'mainnet',
      payee: p.account,
      source: 'onchain' as const,
    }))
  }
}
