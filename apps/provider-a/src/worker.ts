import { Hono } from 'hono'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  routedockHono,
  registerProvider,
  signManifest,
  SupabaseSeenTxStore,
  InMemorySeenTxStore,
  type SeenTxStore,
} from '@routedock/routedock/provider/hono'
import { buildManifest, MPP_CHARGE_PRICE, X402_PRICE } from './manifest.js'
import {
  fetchXlmUsdcOrderBook,
  findStellarConfigProblems,
  resolveAssetContract,
  resolveNetwork,
  type Network,
} from '@routedock/routedock/network'

export interface Env {
  STELLAR_NETWORK?: string
  STELLAR_PAYEE_SECRET: string
  STELLAR_PAYEE_ADDRESS: string
  USDC_ASSET_CONTRACT?: string
  OPENZEPPELIN_API_KEY?: string
  /** Set to "true" to explicitly opt into local x402 settlement on mainnet without OPENZEPPELIN_API_KEY. */
  X402_LOCAL_FACILITATOR?: string
  SUPABASE_URL?: string
  SUPABASE_SERVICE_KEY?: string
  /** Public origin used when recording settlements, e.g. https://api-a.routedock.xyz */
  PUBLIC_BASE_URL?: string
}

export function findStartupProblems(env: Env, network: Network): string[] {
  const problems = findStellarConfigProblems(env, network)
  if (
    network === 'mainnet' &&
    !env.OPENZEPPELIN_API_KEY &&
    env.X402_LOCAL_FACILITATOR !== 'true'
  ) {
    problems.push('OPENZEPPELIN_API_KEY')
  }
  return problems
}

function createApp(env: Env, ctx: ExecutionContext): Hono {
  const network = resolveNetwork(env.STELLAR_NETWORK)

  // The shared config check, asset-contract resolution and Horizon orderbook
  // fetch come from @routedock/routedock/network so provider-a and provider-b
  // cannot drift (issue #578). createApp throws on problems; the result is
  // caught by fetch() below, and healthResponse reports the same list as 503
  // without ever building the app.
  const problems = findStartupProblems(env, network)
  if (problems.length > 0) {
    throw new Error(`Provider misconfigured: ${problems.join(', ')} unset`)
  }

  const useLocalFacilitatorOnMainnet =
    network === 'mainnet' && !env.OPENZEPPELIN_API_KEY && env.X402_LOCAL_FACILITATOR === 'true'
  const activeFacilitator =
    network === 'mainnet' && env.OPENZEPPELIN_API_KEY
      ? 'https://channels.openzeppelin.com/x402'
      : 'local'
  console.log(`[startup] provider-a x402 facilitator=${activeFacilitator} network=${network}`)

  const assetContract = resolveAssetContract(env, network)
  const manifest = buildManifest({
    network,
    payee: env.STELLAR_PAYEE_ADDRESS,
    assetContract,
    localFacilitator: useLocalFacilitatorOnMainnet,
  })

  const supabase: SupabaseClient | null =
    env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY
      ? createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY)
      : null

  const seenTxStore: SeenTxStore = supabase
    ? new SupabaseSeenTxStore(supabase)
    : new InMemorySeenTxStore()

  if (supabase) {
    const baseUrl = env.PUBLIC_BASE_URL ?? 'https://api-a.routedock.xyz'
    const signed = signManifest(manifest, env.STELLAR_PAYEE_SECRET)
    ctx.waitUntil(
      registerProvider({ supabase, manifest: signed, baseUrl, verified: true }).catch((err) => {
        console.error('[registry] Failed to register provider-a:', err)
      }),
    )
  }

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
      const orderbook = await fetchXlmUsdcOrderBook(network, 1)
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
  const network = resolveNetwork(env.STELLAR_NETWORK)
  const missing = findStartupProblems(env, network)
  return Response.json(
    {
      status: missing.length > 0 ? 'misconfigured' : 'ok',
      network,
      payee: addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : 'not configured',
      registry: env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY ? 'connected' : 'not configured',
      ...(missing.length > 0 ? { missing } : {}),
    },
    { status: missing.length > 0 ? 503 : 200 },
  )
}

/**
 * Workers hand `env` to `fetch`, so the app cannot be built at module scope the
 * way the Express server was. Build once per isolate and reuse when `env` is unchanged.
 */
let cachedApp: Hono | null = null
let cachedEnv: Env | null = null

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Answered before the app so the '*' payment middleware never sees it.
    if (new URL(request.url).pathname === '/health') return healthResponse(env)

    try {
      if (!cachedApp || cachedEnv !== env) {
        cachedApp = createApp(env, ctx)
        cachedEnv = env
      }
    } catch (err) {
      console.error('[startup]', err)
      return Response.json({ error: 'Provider misconfigured' }, { status: 500 })
    }
    return cachedApp.fetch(request, env, ctx)
  },
}
