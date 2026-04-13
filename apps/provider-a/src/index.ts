import express from 'express'
import type { Request, Response } from 'express'
import { createClient } from '@supabase/supabase-js'
import { Horizon, Asset } from '@stellar/stellar-sdk'
import { routedock } from '@routedock/routedock/provider'
import type { RouteDockManifest } from '@routedock/routedock'
import Ajv from 'ajv'
// eslint-disable-next-line @typescript-eslint/no-require-imports
const schema = require('../../../packages/sdk/src/schemas/routedock.schema.json') as Record<string, unknown>

// ── Config ────────────────────────────────────────────────────────────────────

const PORT = process.env['PORT'] ?? '3001'
const STELLAR_NETWORK = (process.env['STELLAR_NETWORK'] ?? 'testnet') as 'testnet' | 'mainnet'
const STELLAR_PAYEE_SECRET = process.env['STELLAR_PAYEE_SECRET'] ?? ''
const STELLAR_PAYEE_ADDRESS = process.env['STELLAR_PAYEE_ADDRESS'] ?? ''
const OPENZEPPELIN_API_KEY = process.env['OPENZEPPELIN_API_KEY']
const USDC_ASSET_CONTRACT = process.env['USDC_ASSET_CONTRACT'] ?? 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const SUPABASE_URL = process.env['SUPABASE_URL'] ?? ''
const SUPABASE_SERVICE_KEY = process.env['SUPABASE_SERVICE_KEY'] ?? ''

const HORIZON_URL =
  STELLAR_NETWORK === 'testnet'
    ? 'https://horizon-testnet.stellar.org'
    : 'https://horizon.stellar.org'

// Testnet USDC issuer (Circle); mainnet issuer differs
const USDC_ISSUER =
  STELLAR_NETWORK === 'testnet'
    ? 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
    : 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

// ── Manifest ──────────────────────────────────────────────────────────────────

const manifest: RouteDockManifest = {
  routedock: '1.0',
  name: 'Stellar DEX Price Feed',
  description: 'Real-time USDC/XLM mid-price from Stellar DEX orderbook via Horizon',
  modes: ['x402', 'mpp-charge'],
  network: STELLAR_NETWORK,
  asset: 'USDC',
  asset_contract: USDC_ASSET_CONTRACT,
  payee: STELLAR_PAYEE_ADDRESS,
  pricing: {
    x402: {
      amount: '0.001',
      per: 'request',
      facilitator: `https://channels.openzeppelin.com/x402${STELLAR_NETWORK === 'mainnet' ? '' : '/testnet'}`,
    },
    'mpp-charge': { amount: '0.0008', per: 'request' },
  },
  endpoints: { price: 'GET /price' },
  tags: ['price', 'stellar', 'dex', 'orderbook', 'usdc'],
}

// Required env var check — abort with clear message rather than a deep stack trace
if (!STELLAR_PAYEE_SECRET || !STELLAR_PAYEE_SECRET.startsWith('S')) {
  console.error('FATAL: STELLAR_PAYEE_SECRET is required and must be a valid Stellar secret key (S...)')
  process.exit(1)
}

// Validate manifest against schema at startup — refuse to start if invalid
const ajv = new Ajv()
const validateManifest = ajv.compile(schema)
if (!validateManifest(manifest)) {
  console.error('FATAL: manifest schema validation failed:', validateManifest.errors)
  process.exit(1)
}

// ── Infrastructure ────────────────────────────────────────────────────────────

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    : null

const horizonServer = new Horizon.Server(HORIZON_URL)
const startedAt = Date.now()

// ── Express app ───────────────────────────────────────────────────────────────

const app = express()
app.use(express.json())

app.get('/.well-known/routedock.json', (_req: Request, res: Response) => {
  res.json(manifest)
})

// Payment middleware applied to /price — enforces x402 or mpp-charge before the handler
app.use(
  '/price',
  routedock({
    modes: ['x402', 'mpp-charge'],
    pricing: {
      x402: '0.001',
      'mpp-charge': '0.0008',
    },
    asset: 'USDC',
    assetContract: USDC_ASSET_CONTRACT,
    payee: STELLAR_PAYEE_ADDRESS,
    network: STELLAR_NETWORK,
    payeeSecretKey: STELLAR_PAYEE_SECRET,
    manifest,
    ...(OPENZEPPELIN_API_KEY ? { facilitatorApiKey: OPENZEPPELIN_API_KEY } : {}),
    onSettled: async (txHash: string, amount: string, mode: string) => {
      console.log(`[settled] mode=${mode} txHash=${txHash} amount=${amount}`)
      if (!supabase) return
      const txType = mode === 'mpp-charge' ? 'mpp_charge' : 'x402_settle'
      const { error } = await supabase.from('tx_log').insert({
        tx_type: txType,
        tx_hash: txHash,
        amount: parseFloat(amount),
        mode,
        network: STELLAR_NETWORK,
        provider_url: `http://localhost:${PORT}/price`,
        agent_address: null,
        metadata: { settled_at: new Date().toISOString() },
      })
      if (error) console.error('[supabase] tx_log insert failed:', error.message)
    },
  }),
)

// GET /price — real Stellar DEX orderbook mid-price
app.get('/price', async (_req: Request, res: Response) => {
  try {
    const orderbook = await horizonServer
      .orderbook(Asset.native(), new Asset('USDC', USDC_ISSUER))
      .limit(1)
      .call()

    const ask = orderbook.asks[0]
    const bid = orderbook.bids[0]

    if (!ask || !bid) {
      res.status(503).json({
        error: 'Orderbook unavailable — no asks or bids returned from Horizon',
        asksLength: orderbook.asks.length,
        bidsLength: orderbook.bids.length,
      })
      return
    }

    const midPrice = (parseFloat(ask.price) + parseFloat(bid.price)) / 2

    res.json({
      price: midPrice.toFixed(7),
      pair: 'XLM/USDC',
      timestamp: new Date().toISOString(),
      source: 'stellar-dex',
      network: STELLAR_NETWORK,
    })
  } catch (err) {
    console.error('[horizon] orderbook error:', err)
    res.status(502).json({ error: 'Upstream Horizon error' })
  }
})

// GET /health
app.get('/health', (_req: Request, res: Response) => {
  const payeeDisplay = STELLAR_PAYEE_ADDRESS
    ? `${STELLAR_PAYEE_ADDRESS.slice(0, 6)}...${STELLAR_PAYEE_ADDRESS.slice(-4)}`
    : 'not configured'

  res.json({
    status: 'ok',
    network: STELLAR_NETWORK,
    payee: payeeDisplay,
    uptime: Math.floor((Date.now() - startedAt) / 1000),
  })
})

app.listen(parseInt(PORT, 10), () => {
  console.log(`provider-a listening on port ${PORT} (${STELLAR_NETWORK})`)
})
