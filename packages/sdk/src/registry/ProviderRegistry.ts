import type { SupabaseClient } from '@supabase/supabase-js'
import { OnChainRegistry } from './OnChainRegistry.js'
import { fetchManifest } from '../client/ModeRouter.js'
import { resolveLogger, type RouteDockLogger } from '../internal/logger.js'
import { HORIZON_URLS } from '../network.js'
import type { RouteDockManifest } from '../types.js'

export interface ProviderRecord {
  name: string
  description: string | undefined
  base_url: string
  modes: string[]
  tags: string[]
  network: string
  payee: string
  /** Asset codes the provider accepts, read from its registered manifest (Supabase rows only). */
  assets?: string[]
  source: 'supabase' | 'onchain'
  /**
   * True only when the provider was verified out-of-band — for on-chain
   * records the payee is the account that published the endpoint, for
   * supabase records only rows flagged `verified` are returned.
   */
  verified: boolean
}

/** Options for `ProviderRegistry.listProviders()`. */
export interface ListProvidersOptions {
  /**
   * Also return Supabase rows that are not `verified` (flagged
   * `verified: false`), ordered verified-first then most recently seen.
   * Default false: only operator-verified rows, which is what payee binding
   * relies on.
   */
  includeUnverified?: boolean
  /**
   * Only providers carrying at least one of these tags. Applied inside the
   * Supabase query (before the row limit) and to on-chain records.
   */
  tags?: string[]
}

/** Default and upper bound on Supabase rows read per `listProviders()` call. */
const DEFAULT_LIMIT = 100

export interface ProviderRegistryConfig {
  supabase?: SupabaseClient
  /**
   * Log sink for registry diagnostics (a failing Supabase query, for example).
   * Defaults to a console-backed logger, like the rest of the SDK.
   */
  logger?: RouteDockLogger
  /**
   * Maximum number of Supabase rows read (and so providers returned from that
   * source). Rows are ordered by `registered_at`, so the subset is stable
   * between calls. Defaults to 100.
   */
  limit?: number
  onChain: {
    horizonUrl: string
    knownAccounts: string[]
    /**
     * The Stellar network this registry serves. Optional only for the two
     * public Horizon hosts (`https://horizon.stellar.org` → mainnet,
     * `https://horizon-testnet.stellar.org` → testnet); any other Horizon URL
     * (futurenet, standalone, localhost, a proxy) must pass it, because a wrong
     * guess would hand a client the other network's providers.
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

/**
 * Map one of the two public Horizon hosts to its network. Throws for any other
 * URL: the network cannot be guessed from an arbitrary host, so the caller must
 * pass `onChain.network` explicitly.
 */
export function deriveNetwork(horizonUrl: string): 'testnet' | 'mainnet' {
  const normalized = horizonUrl.trim().replace(/\/+$/, '').toLowerCase()
  if (normalized === HORIZON_URLS.testnet) return 'testnet'
  if (normalized === HORIZON_URLS.mainnet) return 'mainnet'
  throw new Error(
    `Cannot derive the Stellar network from Horizon URL "${horizonUrl}". ` +
      `Pass onChain.network ('testnet' or 'mainnet') explicitly.`,
  )
}

/** Accepted asset codes from a stored manifest (`asset` and `assets[].asset`), de-duplicated in order. */
function manifestAssets(manifest: unknown): string[] {
  if (typeof manifest !== 'object' || manifest === null) return []
  const m = manifest as { asset?: unknown; assets?: unknown }
  const codes: string[] = []
  const add = (code: unknown) => {
    if (typeof code === 'string' && code && !codes.includes(code)) codes.push(code)
  }
  add(m.asset)
  if (Array.isArray(m.assets)) {
    for (const a of m.assets) add(typeof a === 'string' ? a : (a as { asset?: unknown } | null)?.asset)
  }
  return codes
}

/** Normalize a provider base URL to its lowercase origin, the merge key. */
function originKey(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin.toLowerCase()
  } catch {
    return baseUrl.trim().toLowerCase()
  }
}

export class ProviderRegistry {
  private readonly supabase: SupabaseClient | undefined
  private readonly onChain: OnChainRegistry
  private readonly network: 'testnet' | 'mainnet'
  private readonly logger: RouteDockLogger
  private readonly limit: number

  constructor(config: ProviderRegistryConfig) {
    if (config.limit !== undefined && (!Number.isInteger(config.limit) || config.limit < 1)) {
      throw new Error(`ProviderRegistry limit must be a positive integer (received ${config.limit})`)
    }
    this.logger = resolveLogger(config.logger)
    this.limit = config.limit ?? DEFAULT_LIMIT
    this.supabase = config.supabase
    this.network = config.onChain.network ?? deriveNetwork(config.onChain.horizonUrl)
    this.onChain = new OnChainRegistry({
      horizonUrl: config.onChain.horizonUrl,
      knownAccounts: config.onChain.knownAccounts,
      ...(config.onChain.timeoutMs !== undefined ? { timeoutMs: config.onChain.timeoutMs } : {}),
    })
  }

  /**
   * List providers from both sources and merge them by normalized origin.
   * Supabase metadata wins for an origin both sources know; on-chain records
   * fill in every origin Supabase does not list, so the on-chain registry adds
   * providers instead of only acting as a fallback when Supabase is empty. A
   * failure in one source never hides the other.
   */
  async listProviders(options: ListProvidersOptions = {}): Promise<ProviderRecord[]> {
    const tags = options.tags?.filter(Boolean) ?? []
    const [supabaseProviders, onChainAll] = await Promise.all([
      this.trySupabase(options.includeUnverified === true, tags),
      this.tryOnChain(),
    ])
    const onChainProviders =
      tags.length === 0 ? onChainAll : onChainAll.filter((r) => r.tags.some((t) => tags.includes(t)))

    const merged = new Map<string, ProviderRecord>()
    for (const record of [...supabaseProviders, ...onChainProviders]) {
      const key = originKey(record.base_url)
      if (!merged.has(key)) merged.set(key, record)
    }
    return [...merged.values()]
  }

  private async trySupabase(includeUnverified: boolean, tags: string[]): Promise<ProviderRecord[]> {
    if (!this.supabase) return []
    try {
      let query = this.supabase.from('providers').select('*')
      if (!includeUnverified) query = query.eq('verified', true)
      query = query.eq('network', this.network)
      if (tags.length > 0) query = query.overlaps('tags', tags)
      query = includeUnverified
        ? query.order('verified', { ascending: false }).order('last_seen_at', { ascending: false })
        : query.order('registered_at', { ascending: true })
      const { data, error } = await query.limit(this.limit)

      if (error) {
        this.logger('warn', '[ProviderRegistry] Supabase provider query failed', { error })
        return []
      }
      if (!data || data.length === 0) return []

      return (data as unknown as SupabaseProviderRow[]).map((r) => ({
        name: r.name,
        description: r.description ?? undefined,
        base_url: r.base_url,
        modes: r.modes,
        tags: r.tags,
        network: r.network,
        payee: r.payee,
        assets: manifestAssets(r.manifest),
        source: 'supabase' as const,
        verified: r.verified === true,
      }))
    } catch (error) {
      this.logger('warn', '[ProviderRegistry] Supabase provider query threw', { error })
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
