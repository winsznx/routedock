import express from 'express'
import type { Request, Response } from 'express'
import { createClient } from '@supabase/supabase-js'
import { Horizon, Asset } from '@stellar/stellar-sdk'
import { routedock } from '@routedock/routedock/provider'
import type { RouteDockManifest } from '@routedock/routedock'
import Ajv from 'ajv'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const schema = require('./routedock.schema.json') as Record<string, unknown>

// ── Config ────────────────────────────────────────────────────────────────────

const PORT = process.env['PORT'] ?? '3002'
const STELLAR_NETWORK = (process.env['STELLAR_NETWORK'] ?? 'testnet') as 'testnet' | 'mainnet'
const STELLAR_PAYEE_SECRET = process.env['STELLAR_PAYEE_SECRET'] ?? ''
const STELLAR_PAYEE_ADDRESS = process.env['STELLAR_PAYEE_ADDRESS'] ?? ''
const CHANNEL_CONTRACT_ID = process.env['CHANNEL_CONTRACT_ID'] ?? ''
const COMMITMENT_PUBLIC_KEY = process.env['COMMITMENT_PUBLIC_KEY'] ?? ''
const USDC_ASSET_CONTRACT = process.env['USDC_ASSET_CONTRACT'] ?? 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const SUPABASE_URL = process.env['SUPABASE_URL'] ?? ''
const SUPABASE_SERVICE_KEY = process.env['SUPABASE_SERVICE_KEY'] ?? ''

const HORIZON_URL =
  STELLAR_NETWORK === 'testnet'
    ? 'https://horizon-testnet.stellar.org'
    : 'https://horizon.stellar.org'

const USDC_ISSUER =
  STELLAR_NETWORK === 'testnet'
    ? 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
    : 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'

// ── Manifest ──────────────────────────────────────────────────────────────────

const manifest: RouteDockManifest = {
  routedock: '1.0',
  name: 'Stellar DEX Orderbook Stream',
  description: 'Real-time USDC/XLM orderbook SSE stream from Stellar Horizon',
  modes: ['mpp-session'],
  network: STELLAR_NETWORK,
  asset: 'USDC',
  asset_contract: USDC_ASSET_CONTRACT,
  payee: STELLAR_PAYEE_ADDRESS,
  pricing: {
    'mpp-session': {
      rate: '0.0001',
      per: 'voucher',
      channel_contract: CHANNEL_CONTRACT_ID,
      min_deposit: '0.10',
      refund_waiting_period_ledgers: 17280,
    },
  },
  endpoints: { stream: 'GET /stream/orderbook' },
  tags: ['stream', 'stellar', 'dex', 'orderbook', 'usdc', 'sse', 'realtime'],
}

// Required env var check
if (!STELLAR_PAYEE_SECRET || !STELLAR_PAYEE_SECRET.startsWith('S')) {
  console.error('FATAL: STELLAR_PAYEE_SECRET is required and must be a valid Stellar secret key (S...)')
  process.exit(1)
}
if (!CHANNEL_CONTRACT_ID || !CHANNEL_CONTRACT_ID.startsWith('C')) {
  console.error('FATAL: CHANNEL_CONTRACT_ID is required and must be a valid Soroban contract address (C...)')
  process.exit(1)
}
if (!COMMITMENT_PUBLIC_KEY || !COMMITMENT_PUBLIC_KEY.startsWith('G')) {
  console.error('FATAL: COMMITMENT_PUBLIC_KEY is required and must be a valid Stellar public key (G...)')
  process.exit(1)
}

// Validate manifest at startup — refuse to start if invalid
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

// Payment middleware applied to /stream/orderbook — enforces mpp-session voucher
app.use(
  '/stream/orderbook',
  routedock({
    modes: ['mpp-session'],
    pricing: {
      'mpp-session': {
        rate: '0.0001',
        channelContract: CHANNEL_CONTRACT_ID,
      },
    },
    asset: 'USDC',
    assetContract: USDC_ASSET_CONTRACT,
    payee: STELLAR_PAYEE_ADDRESS,
    network: STELLAR_NETWORK,
    payeeSecretKey: STELLAR_PAYEE_SECRET,
    manifest,
    commitmentPublicKey: COMMITMENT_PUBLIC_KEY,
    onSettled: async (txHash: string, totalPaid: string, mode: string) => {
      console.log(`[settled] mode=${mode} txHash=${txHash} totalPaid=${totalPaid}`)
      if (!supabase) return
      const { error } = await supabase.from('tx_log').insert({
        tx_type: 'channel_close',
        tx_hash: txHash,
        amount: parseFloat(totalPaid),
        mode,
        network: STELLAR_NETWORK,
        provider_url: `http://localhost:${PORT}/stream/orderbook`,
        agent_address: null,
        metadata: { settled_at: new Date().toISOString() },
      })
      if (error) console.error('[supabase] tx_log insert failed:', error.message)
    },
  }),
)

// GET /stream/orderbook — returns a single orderbook snapshot per paid request.
// Each request is one voucher in the payment channel — pay-per-interaction.
app.get('/stream/orderbook', async (_req: Request, res: Response) => {
  try {
    const orderbook = await horizonServer
      .orderbook(Asset.native(), new Asset('USDC', USDC_ISSUER))
      .limit(5)
      .call()

    res.json({
      pair: 'XLM/USDC',
      timestamp: new Date().toISOString(),
      source: 'stellar-dex',
      network: STELLAR_NETWORK,
      asks: orderbook.asks.slice(0, 5).map(a => ({ price: a.price, amount: a.amount })),
      bids: orderbook.bids.slice(0, 5).map(b => ({ price: b.price, amount: b.amount })),
    })
  } catch (err) {
    console.error('[horizon] orderbook error:', err)
    res.status(502).json({ error: 'Upstream Horizon error' })
  }
})

// DELETE /stream/orderbook — close the payment channel
app.delete('/stream/orderbook', (_req: Request, res: Response) => {
  res.json({ message: 'close handled by middleware' })
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
  console.log(`provider-b listening on port ${PORT} (${STELLAR_NETWORK})`)
})
