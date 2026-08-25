import { Hono } from 'hono'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { routedockHono } from '@routedock/routedock/provider/hono'
import {
  buildManifest,
  HORIZON_URLS,
  MPP_CHARGE_PRICE,
  TESTNET_USDC_CONTRACT,
  USDC_ISSUERS,
  X402_PRICE,
  type Network,
} from './manifest.js'
import {
  InMemorySeenTxStore,
  SupabaseSeenTxStore,
  type SeenTxStore,
} from './SupabaseSeenTxStore.js'

export interface Env {
  STELLAR_NETWORK?: string
  STELLAR_PAYEE_SECRET: string
  STELLAR_PAYEE_ADDRESS: string
  USDC_ASSET_CONTRACT?: string
  OPENZEPPELIN_API_KEY?: string
  SUPABASE_URL?: string
  SUPABASE_SERVICE_KEY?: string
  /** Public origin used when recording settlements, e.g. https://api-a.routedock.xyz */
  PUBLIC_BASE_URL?: string
}

interface OrderBookLevel {
  price: string
  amount: string
}

interface OrderBookResponse {
  asks: OrderBookLevel[]
  bids: OrderBookLevel[]
}

function resolveNetwork(raw: string | undefined): Network {
  return raw === 'mainnet' ? 'mainnet' : 'testnet'
}

function resolveAssetContract(env: Env, network: Network): string {
  if (env.USDC_ASSET_CONTRACT) return env.USDC_ASSET_CONTRACT
  if (network === 'testnet') return TESTNET_USDC_CONTRACT
  throw new Error('USDC_ASSET_CONTRACT is required for mainnet')
}

/**
 * Fetch the XLM/USDC orderbook straight from Horizon's REST API.
 *
 * The Express build used `Horizon.Server(...).orderbook(...)`, which pulls the
 * whole `@stellar/stellar-sdk` (and axios) into the bundle for what is a single
 * GET. Calling the endpoint keeps the Worker small and drops the dependency.
 */
async function fetchOrderBook(network: Network, limit: number): Promise<OrderBookResponse> {
  const params = new URLSearchParams({
    selling_asset_type: 'native',
    buying_asset_type: 'credit_alphanum4',
    buying_asset_code: 'USDC',
    buying_asset_issuer: USDC_ISSUERS[network],
    limit: String(limit),
  })

  const response = await fetch(`${HORIZON_URLS[network]}/order_book?${params.toString()}`, {
    headers: { accept: 'application/json' },
  })

  if (!response.ok) {
    throw new Error(`Horizon responded ${response.status}`)
  }

  return (await response.json()) as OrderBookResponse
}

function createApp(env: Env): Hono {
  const network = resolveNetwork(env.STELLAR_NETWORK)
  const assetContract = resolveAssetContract(env, network)

  if (!env.STELLAR_PAYEE_SECRET || !env.STELLAR_PAYEE_SECRET.startsWith('S')) {
    throw new Error('STELLAR_PAYEE_SECRET is required and must be a valid Stellar secret key (S...)')
  }
  if (!env.STELLAR_PAYEE_ADDRESS) {
    throw new Error('STELLAR_PAYEE_ADDRESS is required')
  }

  const manifest = buildManifest({ network, payee: env.STELLAR_PAYEE_ADDRESS, assetContract })

  const supabase: SupabaseClient | null =
    env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY
      ? createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY)
      : null

  const seenTxStore: SeenTxStore = supabase
    ? new SupabaseSeenTxStore(supabase)
    : new InMemorySeenTxStore()

  const providerUrl = `${env.PUBLIC_BASE_URL ?? 'https://api-a.routedock.xyz'}/price`

  const app = new Hono()

  // Mounted at '*', not '/price', so routedockHono's own
  // /.well-known/routedock.json branch serves the SIGNED manifest. Scoping it
  // to /price leaves the well-known route unsigned, and mandatory signature
  // verification (PR #86) then makes every client.pay() throw
  // RouteDockSignatureError before any payment — issue #134. /health is
  // answered in fetch() below, before this middleware can demand payment.
  app.use(
    '*',
    routedockHono({
      modes: ['x402', 'mpp-charge'],
      pricing: { x402: X402_PRICE, 'mpp-charge': MPP_CHARGE_PRICE },
      asset: 'USDC',
      assetContract,
      payee: env.STELLAR_PAYEE_ADDRESS,
      network,
      payeeSecretKey: env.STELLAR_PAYEE_SECRET,
      manifest,
      seenTxStore,
      ...(env.OPENZEPPELIN_API_KEY ? { facilitatorApiKey: env.OPENZEPPELIN_API_KEY } : {}),
      onSettled: async (txHash, amount, mode, payer) => {
        console.log(`[settled] mode=${mode} txHash=${txHash} amount=${amount} payer=${payer ?? 'unknown'}`)
        if (!supabase) return
        const { error } = await supabase.from('tx_log').insert({
          tx_type: mode === 'mpp-charge' ? 'mpp_charge' : 'x402_settle',
          tx_hash: txHash,
          amount: parseFloat(amount),
          mode,
          network,
          provider_url: providerUrl,
          agent_address: payer,
          metadata: { settled_at: new Date().toISOString() },
        })
        if (error) console.error('[supabase] tx_log insert failed:', error.message)
      },
    }),
  )

  app.get('/price', async (c) => {
    try {
      const orderbook = await fetchOrderBook(network, 1)
      const ask = orderbook.asks[0]
      const bid = orderbook.bids[0]

      if (!ask || !bid) {
        return c.json(
          {
            error: 'Orderbook unavailable — no asks or bids returned from Horizon',
            asksLength: orderbook.asks.length,
            bidsLength: orderbook.bids.length,
          },
          503,
        )
      }

      const midPrice = (parseFloat(ask.price) + parseFloat(bid.price)) / 2

      return c.json({
        price: midPrice.toFixed(7),
        pair: 'XLM/USDC',
        timestamp: new Date().toISOString(),
        source: 'stellar-dex',
        network,
      })
    } catch (err) {
      console.error('[horizon] orderbook error:', err)
      return c.json({ error: 'Upstream Horizon error' }, 502)
    }
  })

  return app
}

function healthResponse(env: Env): Response {
  const addr = env.STELLAR_PAYEE_ADDRESS
  return Response.json({
    status: 'ok',
    network: resolveNetwork(env.STELLAR_NETWORK),
    payee: addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : 'not configured',
    registry: env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY ? 'connected' : 'not configured',
  })
}

/**
 * Workers hand `env` to `fetch`, so the app cannot be built at module scope the
 * way the Express server was. Build once per isolate and reuse.
 */
let cachedApp: Hono | null = null

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Answered before the app so the '*' payment middleware never sees it.
    if (new URL(request.url).pathname === '/health') return healthResponse(env)

    try {
      cachedApp ??= createApp(env)
    } catch (err) {
      console.error('[startup]', err)
      return Response.json({ error: 'Provider misconfigured' }, { status: 500 })
    }
    return cachedApp.fetch(request, env, ctx)
  },
}
