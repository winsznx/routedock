/**
 * handlers.ts
 *
 * Pure, unit-testable handler functions for every MCP tool exposed by the
 * RouteDock MCP server.  All external I/O dependencies (RouteDockClient,
 * Supabase, Stellar Horizon, the in-process openSessions map) are injected via
 * the `HandlerDeps` parameter so tests can supply lightweight fakes without
 * touching the network.
 *
 * index.ts is responsible only for wiring: constructing real deps, building
 * the MCP Server, and dispatching to these functions.
 */

import type { RouteDockClient, SessionHandle, PaymentMode } from '@routedock/routedock'
import { usdcToStroops } from '@routedock/routedock'
// Canonical Horizon endpoints (issue #578): the server keeps one copy of the
// URL table instead of a third one next to the providers and the SDK.
import { HORIZON_URLS } from '@routedock/routedock/network'
import { Keypair, Horizon } from '@stellar/stellar-sdk'
import { MAX_STREAM_MESSAGES } from './tools.js'

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/** The shape every handler returns — compatible with MCP CallToolResult.
 * Must be a type alias (not interface) so TypeScript infers the implicit index
 * signature required by MCP SDK 1.29's ServerResult union. */
export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: true
}

/** Database row representation for a provider in Supabase registry. */
export interface ProviderRow {
  name: string
  description: string
  network: string
  asset: string
  modes: string[]
  tags: string[]
  base_url: string
  [key: string]: unknown
}

export interface SupabaseQueryResult {
  data: ProviderRow[] | null
  error: { message: string } | null
}

/** Chainable query builder type for Supabase provider queries. */
export interface SupabaseQueryBuilder {
  eq?: (field: string, value: unknown) => SupabaseQueryBuilder
  overlaps?: (field: string, values: string[]) => SupabaseQueryBuilder | Promise<SupabaseQueryResult>
  then?: (onfulfilled: (res: SupabaseQueryResult) => unknown) => unknown
  [key: string]: unknown
}

/** All external dependencies required by the handlers.  Inject fakes in tests. */
export interface HandlerDeps {
  /** Initialised RouteDockClient for paying / opening sessions. */
  client: RouteDockClient
  /** Live sessions keyed by channelId; shared across open/stream/close. */
  openSessions: Map<string, SessionHandle>
  /** Supabase client for list_providers, or null when not configured. */
  supabase: {
    from: (table: string) => {
      select: (cols: string) => SupabaseQueryBuilder
    }
    /** Calls a SQL function; used by list_providers when `query` is set. */
    rpc?: (fn: string, args?: Record<string, unknown>) => PromiseLike<SupabaseQueryResult>
  } | null
  /** Raw Stellar secret key — used by check_balance to derive the public key. */
  stellarSecret: string
  /** 'testnet' | 'mainnet' — controls which Horizon endpoint is queried. */
  stellarNetwork: 'testnet' | 'mainnet'
  /**
   * Optional: override the Horizon.Server constructor for testing.
   * When omitted the handler creates a real Horizon.Server from stellarNetwork.
   */
  createHorizonServer?: (url: string) => {
    loadAccount: (publicKey: string) => Promise<{ balances: HorizonBalance[] }>
  }
  /**
   * Optional: override the fetch used by open_session's min_deposit preflight.
   * When omitted the global fetch is used.
   */
  fetchManifest?: (url: string) => Promise<{ json: () => Promise<unknown> }>
}

// ---------------------------------------------------------------------------
// ok / err helpers
// ---------------------------------------------------------------------------

function ok(payload: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  }
}

function err(message: string): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ success: false, error: message }, null, 2) }],
    isError: true,
  }
}

// ---------------------------------------------------------------------------
// pay_for_data
// ---------------------------------------------------------------------------

export interface PayForDataArgs {
  url: string
  max_amount: string
  preferred_mode?: PaymentMode
}

/** Parse a decimal USDC string to stroops, or null when it is not one. */
function parseUsdc(amount: unknown): bigint | null {
  // usdcToStroops calls amount.trim(), so non-strings must be rejected first.
  if (typeof amount !== 'string') return null
  try {
    return usdcToStroops(amount)
  } catch {
    return null
  }
}

/**
 * Validate price against max_amount then execute the payment.
 *
 * MCP does not validate arguments against inputSchema, so max_amount is
 * checked here. A missing or non-numeric ceiling used to make the comparison
 * NaN-false and pay with no limit (issue #316). Both amounts are compared
 * exactly in stroops.
 *
 * preferred_mode maps to ModeSelectOptions.forceMode — the field is NOT called
 * preferredMode, so we must not pass it by that name (silent drop, issue #199).
 */
export async function handlePayForData(
  args: PayForDataArgs,
  deps: HandlerDeps,
): Promise<ToolResult> {
  const { url, max_amount, preferred_mode } = args
  const { client } = deps

  const maxStroops = parseUsdc(max_amount)
  if (maxStroops === null || maxStroops === 0n) {
    return err(
      `max_amount must be a positive USDC amount as a decimal string with at most 7 decimal places, ` +
        `e.g. "0.01" (received ${JSON.stringify(max_amount) ?? 'nothing'})`,
    )
  }

  const modeOptions = preferred_mode
    ? { forceMode: preferred_mode as PaymentMode }
    : undefined

  const estimate = await client.estimateCost(url, modeOptions)

  const priceStroops = parseUsdc(estimate.amount)
  if (priceStroops === null) {
    return err('Provider returned an undefined or invalid price')
  }

  if (priceStroops > maxStroops) {
    return err(
      `Provider cost ${estimate.amount} ${estimate.asset} exceeds max_amount ${max_amount} USDC`,
    )
  }

  const result = await client.pay(url, modeOptions)

  return ok({
    success: true,
    mode: result.mode,
    amount: result.amount,
    tx_hash: result.txHash,
    timestamp: result.timestamp,
    data: result.data,
  })
}

// ---------------------------------------------------------------------------
// open_session
// ---------------------------------------------------------------------------

export interface OpenSessionArgs {
  url: string
  initial_deposit?: string
}

/** The manifest fields open_session reads. The JSON is unverified, so every
 * field is treated as untrusted and checked before use. */
interface OpenSessionManifest {
  pricing?: Record<string, { min_deposit?: string }>
  endpoints?: Record<string, { method?: unknown; path?: unknown }>
}

/**
 * Resolve a bare provider origin to its streaming endpoint using the manifest.
 *
 * The SDK uses the URL handed to openSession as the exact voucher and DELETE
 * target, so a bare origin pays for vouchers that hit a 404 (issue #317).
 * Prefers `endpoints.stream`, else the sole endpoint. The result must stay on
 * the requested origin so a manifest cannot redirect the session elsewhere.
 */
function resolveSessionEndpoint(
  origin: string,
  manifest: OpenSessionManifest | null,
): { url: string } | { error: string } {
  const raw = manifest?.endpoints
  const endpoints =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const entries = Object.entries(endpoints)

  const listing =
    entries.length > 0
      ? entries
          .map(([name, e]) => `${name}: ${String(e?.method)} ${String(e?.path)}`)
          .join(', ')
      : '(none)'
  const fail = (reason: string) => ({
    error:
      `Could not resolve a streaming endpoint for ${origin}: ${reason}. ` +
      `Endpoints in its manifest: ${listing}. ` +
      `Call open_session again with the full endpoint URL (e.g. ${origin}/stream/orderbook).`,
  })

  let chosen: [string, { method?: unknown; path?: unknown }] | undefined
  if (Object.hasOwn(endpoints, 'stream')) {
    chosen = ['stream', endpoints.stream!]
  } else if (entries.length === 1) {
    chosen = entries[0]
  }
  if (!chosen) {
    return fail(
      entries.length === 0
        ? 'the manifest lists no endpoints'
        : `the manifest has no "stream" endpoint and ${entries.length} others to choose from`,
    )
  }

  const [name, endpoint] = chosen
  const method = typeof endpoint?.method === 'string' ? endpoint.method.toUpperCase() : ''
  if (method !== 'GET') {
    return fail(`endpoint "${name}" uses method ${String(endpoint?.method)}, but sessions stream with GET`)
  }
  if (typeof endpoint.path !== 'string') {
    return fail(`endpoint "${name}" has no path`)
  }

  let resolved: URL
  try {
    resolved = new URL(endpoint.path, origin)
  } catch {
    return fail(`endpoint "${name}" has an invalid path`)
  }
  if (resolved.origin !== origin) {
    return fail(`endpoint "${name}" points outside ${origin}`)
  }
  return { url: resolved.href }
}

/**
 * Optionally run the min_deposit preflight, resolve a bare provider origin to
 * its streaming endpoint, then open an MPP session and store the live handle
 * in `openSessions` so stream_session / close_session can find it.
 */
export async function handleOpenSession(
  args: OpenSessionArgs,
  deps: HandlerDeps,
  commitmentSecret: string | undefined,
): Promise<ToolResult> {
  const { url, initial_deposit } = args
  const { client, openSessions, fetchManifest } = deps

  if (!commitmentSecret) {
    return err('COMMITMENT_SECRET environment variable is required for session mode')
  }

  const parsed = new URL(url)
  const origin = parsed.origin
  const isBareOrigin = parsed.pathname === '' || parsed.pathname === '/'

  // Fetched at most once and shared by the min_deposit check and endpoint resolution.
  let cachedManifest: OpenSessionManifest | null | undefined
  const loadManifest = async (): Promise<OpenSessionManifest | null> => {
    if (cachedManifest === undefined) {
      const fetcher = fetchManifest ?? ((u: string) => fetch(u))
      const manifestResponse = await fetcher(`${origin}/.well-known/routedock.json`)
      cachedManifest = (await manifestResponse.json()) as OpenSessionManifest | null
    }
    return cachedManifest
  }

  if (initial_deposit) {
    const manifest = await loadManifest()

    const minDeposit =
      manifest?.pricing?.['mpp-session']?.min_deposit ??
      manifest?.pricing?.['mpp-session-ws']?.min_deposit
    if (minDeposit && parseFloat(initial_deposit) < parseFloat(minDeposit)) {
      return err(
        `initial_deposit ${initial_deposit} is below this provider's min_deposit ${minDeposit}. ` +
          `RouteDock channels are pre-deployed and funded out-of-band before the agent runs — ` +
          `make sure the channel is funded with at least min_deposit before opening a session.`,
      )
    }
  }

  let endpointUrl = url
  if (isBareOrigin) {
    const resolution = resolveSessionEndpoint(origin, await loadManifest())
    if ('error' in resolution) {
      return err(resolution.error)
    }
    endpointUrl = resolution.url
  }

  const session = await client.openSession(endpointUrl)
  openSessions.set(session.channelId, session)

  return ok({
    success: true,
    channel_id: session.channelId,
    open_tx_hash: session.openTxHash,
    endpoint_url: endpointUrl,
    message:
      'Session opened successfully. Use stream_session to pull data and close_session to settle and release the channel collateral.',
  })
}

// ---------------------------------------------------------------------------
// stream_session
// ---------------------------------------------------------------------------

export interface StreamSessionArgs {
  channel_id: string
  max_messages?: number
}

/**
 * Pull up to max_messages items from the async iterator exposed by an open session.
 *
 * A voucher failure mid-batch (cap reached, provider 4xx/5xx) must not discard
 * messages that were already paid for: the handler catches the rejection and
 * returns the partial batch together with the session stats instead of letting
 * the dispatcher replace the whole result with a bare error.
 */
export async function handleStreamSession(
  args: StreamSessionArgs,
  deps: HandlerDeps,
): Promise<ToolResult> {
  const { channel_id, max_messages } = args
  const { openSessions } = deps

  const session = openSessions.get(channel_id)
  if (!session) {
    return err(
      `No open session found for channel_id ${channel_id}. It may have already been closed, ` +
        `auto-closed after its wall-clock lifetime guard, or opened by a different server process.`,
    )
  }

  if (
    max_messages !== undefined &&
    (!Number.isInteger(max_messages) || max_messages < 1 || max_messages > MAX_STREAM_MESSAGES)
  ) {
    return err(
      `max_messages must be an integer between 1 and ${MAX_STREAM_MESSAGES} (received ${max_messages})`,
    )
  }

  const limit = max_messages ?? 1
  const messages: unknown[] = []
  const iterator = session.stream()[Symbol.asyncIterator]()

  try {
    for (let i = 0; i < limit; i++) {
      const { value, done } = await iterator.next()
      if (done) break
      messages.push(value)
    }
  } catch (error) {
    // Return the already-paid messages rather than losing them. Do not rethrow:
    // the dispatcher's catch would drop the batch and the spend it represents.
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              success: false,
              error: error instanceof Error ? error.message : String(error),
              channel_id,
              count: messages.length,
              messages,
              stats: session.stats(),
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    }
  } finally {
    // Close the generator created for this call so it does not linger.
    await iterator.return?.()
  }

  return ok({
    success: true,
    channel_id,
    count: messages.length,
    messages,
  })
}

// ---------------------------------------------------------------------------
// close_session
// ---------------------------------------------------------------------------

export interface CloseSessionArgs {
  channel_id: string
}

/**
 * Settle the channel on-chain with the highest signed voucher, then evict it
 * from the in-process openSessions map.
 */
export async function handleCloseSession(
  args: CloseSessionArgs,
  deps: HandlerDeps,
): Promise<ToolResult> {
  const { channel_id } = args
  const { openSessions } = deps

  const session = openSessions.get(channel_id)
  if (!session) {
    return err(
      `No open session found for channel_id ${channel_id}. It may have already been closed or ` +
        `auto-closed after its wall-clock lifetime guard.`,
    )
  }

  const result = await session.close()
  openSessions.delete(channel_id)

  return ok({
    success: true,
    channel_id,
    close_tx_hash: result.closeTxHash,
    total_paid: result.totalPaid,
    vouchers_issued: result.vouchersIssued,
  })
}

// ---------------------------------------------------------------------------
// check_balance
// ---------------------------------------------------------------------------

export interface CheckBalanceArgs {
  asset_code?: string
  asset_issuer?: string
}

/**
 * Normalized Horizon balance line, flattened across Horizon's discriminated
 * union (BalanceLineNative | BalanceLineAsset | BalanceLineLiquidityPool).
 * exactOptionalPropertyTypes requires explicit `| undefined` on each optional.
 */
export type HorizonBalance = {
  asset_type?: string | undefined
  asset_code?: string | undefined
  asset_issuer?: string | undefined
  balance: string
}

function normalizeBalances(
  balances: ReadonlyArray<HorizonBalance | Horizon.HorizonApi.BalanceLine>,
): HorizonBalance[] {
  return balances.map((b) => ({
    asset_type: b.asset_type,
    asset_code: 'asset_code' in b ? b.asset_code : undefined,
    asset_issuer: 'asset_issuer' in b ? b.asset_issuer : undefined,
    balance: b.balance,
  }))
}

/**
 * Load the Stellar account and return the requested balance.
 * Uses `createHorizonServer` from deps when provided (for tests), otherwise
 * constructs a real Horizon.Server.
 */
export async function handleCheckBalance(
  args: CheckBalanceArgs,
  deps: HandlerDeps,
): Promise<ToolResult> {
  const { asset_code, asset_issuer } = args
  const { stellarSecret, stellarNetwork, createHorizonServer } = deps

  const keypair = Keypair.fromSecret(stellarSecret)
  const horizonUrl = HORIZON_URLS[stellarNetwork]

  const horizonServer = createHorizonServer
    ? createHorizonServer(horizonUrl)
    : new Horizon.Server(horizonUrl)

  const account = await horizonServer.loadAccount(keypair.publicKey())
  // Normalize the discriminated union into a flat shape so asset_code /
  // asset_issuer field access compiles under strictNullChecks.
  const balances = normalizeBalances(account.balances)

  if (asset_code && asset_issuer) {
    const balance = balances.find(
      (b) => b.asset_code === asset_code && b.asset_issuer === asset_issuer,
    )
    return ok({
      asset: asset_code,
      issuer: asset_issuer,
      balance: balance ? balance.balance : '0',
      account: keypair.publicKey(),
    })
  }

  if (asset_code) {
    const balance = balances.find((b) => b.asset_code === asset_code)
    return ok({
      asset: asset_code,
      balance: balance ? balance.balance : '0',
      account: keypair.publicKey(),
    })
  }

  // Default: native XLM
  const nativeBalance = balances.find((b) => b.asset_type === 'native')
  return ok({
    asset: 'XLM',
    balance: nativeBalance ? nativeBalance.balance : '0',
    account: keypair.publicKey(),
  })
}

// ---------------------------------------------------------------------------
// list_providers
// ---------------------------------------------------------------------------

export interface ListProvidersArgs {
  tags?: string
  network?: 'testnet' | 'mainnet'
  /** Free-text capability search, e.g. "streaming price feed". */
  query?: string
}

/**
 * Query the Supabase provider registry.
 *
 * Without `query`, apply the optional tag-overlap and network filters. The
 * tags column is a TEXT[] with a GIN index — we use .overlaps(), not full-text
 * search.
 *
 * With `query`, call the `search_providers` SQL function, which ranks verified
 * providers by trigram similarity of name and description. `tags`, if also
 * given, then narrows the ranked results to providers sharing any of them.
 */
export async function handleListProviders(
  args: ListProvidersArgs,
  deps: HandlerDeps,
): Promise<ToolResult> {
  const { tags, network } = args
  const { supabase } = deps
  const searchText = args.query?.trim()

  if (!supabase) {
    return err(
      'SUPABASE_URL and SUPABASE_KEY environment variables are required for provider registry access',
    )
  }

  if (searchText) {
    return searchProviders(searchText, tags, network, supabase)
  }

  // Build query — start with the full select, apply filters progressively.
  let query: SupabaseQueryBuilder = supabase.from('providers').select('*')

  if (network && query.eq) {
    query = query.eq('network', network)
  }

  if (tags) {
    const tagList = tags
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
    if (tagList.length > 0 && query.overlaps) {
      // tags column is TEXT[] — array overlap, not textSearch
      query = query.overlaps('tags', tagList) as unknown as SupabaseQueryBuilder
    }
  }

  const { data, error } = await (query as unknown as PromiseLike<SupabaseQueryResult>)

  if (error) {
    return err(`Failed to fetch providers: ${error.message}`)
  }

  const rows = data ?? []

  return providersResult(rows)
}

function parseTagList(tags: string | undefined): string[] {
  return (tags ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
}

async function searchProviders(
  searchText: string,
  tags: string | undefined,
  network: 'testnet' | 'mainnet' | undefined,
  supabase: NonNullable<HandlerDeps['supabase']>,
): Promise<ToolResult> {
  if (!supabase.rpc) {
    return err('Provider search is not available: the Supabase client does not support rpc()')
  }

  const { data, error } = await supabase.rpc('search_providers', {
    query: searchText,
    network: network ?? null,
    verified_only: true,
    max_results: 20,
  })

  if (error) {
    return err(`Failed to search providers: ${error.message}`)
  }

  const tagList = parseTagList(tags)
  const rows = (data ?? []).filter(
    (p: ProviderRow) => tagList.length === 0 || p.tags.some((t) => tagList.includes(t)),
  )

  return providersResult(rows)
}

function providersResult(rows: ProviderRow[]): ToolResult {
  return ok({
    success: true,
    count: rows.length,
    providers: rows.map((p) => ({
      name: p.name,
      description: p.description,
      network: p.network,
      asset: p.asset,
      modes: p.modes,
      tags: p.tags,
      base_url: p.base_url,
    })),
  })
}
