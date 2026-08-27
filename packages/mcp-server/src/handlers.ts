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
import { Keypair, Horizon } from '@stellar/stellar-sdk'

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
  preferred_mode?: 'x402' | 'mpp-charge' | 'mpp-session'
}

/**
 * Validate price against max_amount then execute the payment.
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

  const modeOptions = preferred_mode
    ? { forceMode: preferred_mode as PaymentMode }
    : undefined

  const estimate = await client.estimateCost(url, modeOptions)

  if (estimate.amount === undefined || isNaN(parseFloat(estimate.amount))) {
    return err('Provider returned an undefined or invalid price')
  }

  if (parseFloat(estimate.amount) > parseFloat(max_amount)) {
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

/**
 * Optionally run the min_deposit preflight, then open an MPP session and store
 * the live handle in `openSessions` so stream_session / close_session can find it.
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

  if (initial_deposit) {
    const baseUrl = new URL(url).origin
    const manifestUrl = `${baseUrl}/.well-known/routedock.json`

    const fetcher = fetchManifest ?? ((u: string) => fetch(u))
    const manifestResponse = await fetcher(manifestUrl)
    const manifest = (await manifestResponse.json()) as {
      pricing?: Record<string, { min_deposit?: string }>
    }

    const minDeposit = manifest?.pricing?.['mpp-session']?.min_deposit
    if (minDeposit && parseFloat(initial_deposit) < parseFloat(minDeposit)) {
      return err(
        `initial_deposit ${initial_deposit} is below this provider's min_deposit ${minDeposit}. ` +
          `RouteDock channels are pre-deployed and funded out-of-band before the agent runs — ` +
          `make sure the channel is funded with at least min_deposit before opening a session.`,
      )
    }
  }

  const session = await client.openSession(url)
  openSessions.set(session.channelId, session)

  return ok({
    success: true,
    channel_id: session.channelId,
    open_tx_hash: session.openTxHash,
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

  const limit = Math.max(1, max_messages ?? 1)
  const messages: unknown[] = []
  const iterator = session.stream()[Symbol.asyncIterator]()

  for (let i = 0; i < limit; i++) {
    const { value, done } = await iterator.next()
    if (done) break
    messages.push(value)
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

const HORIZON_URLS = {
  mainnet: 'https://horizon.stellar.org',
  testnet: 'https://horizon-testnet.stellar.org',
} as const

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
}

/**
 * Query the Supabase provider registry with optional tag-overlap and network
 * filters.  Tags column is a TEXT[] with a GIN index — we use .overlaps(), not
 * full-text search.
 */
export async function handleListProviders(
  args: ListProvidersArgs,
  deps: HandlerDeps,
): Promise<ToolResult> {
  const { tags, network } = args
  const { supabase } = deps

  if (!supabase) {
    return err(
      'SUPABASE_URL and SUPABASE_KEY environment variables are required for provider registry access',
    )
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

  return ok({
    success: true,
    count: rows.length,
    providers: rows.map((p: ProviderRow) => ({
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
