/**
 * price-oracle-agent — x402 one-shot payment example
 *
 * Pays Provider A's GET /price endpoint using the x402 protocol.
 * No session channel is needed — each call is a discrete on-chain settlement.
 *
 * Flow:
 *   1. RouteDockClient fetches Provider A's manifest.
 *   2. selectMode() picks x402 (forced here for illustration).
 *   3. X402Client sends initial GET, receives 402 + X-Payment-Requirements.
 *   4. Signs a payment payload and retries with payment-signature header.
 *   5. Provider settles on-chain; returns price data + X-Payment-Response.
 */

import { RouteDockClient } from '@routedock/sdk'

const PROVIDER_A_URL = cleanUrl(process.env['PROVIDER_A_URL'] ?? 'https://api-a.routedock.xyz')
const PRICE_URL = `${PROVIDER_A_URL}/price`
const STELLAR_NETWORK = process.env['STELLAR_NETWORK'] === 'mainnet' ? 'mainnet' : 'testnet'
const AGENT_SECRET = process.env['AGENT_SECRET'] ?? ''

// How many price quotes to fetch. Each costs one on-chain x402 settlement.
const QUOTE_COUNT = 3

function cleanUrl(url: string): string {
    return url.replace(/\/$/, '')
}

function requireSecret(name: string, value: string): void {
    if (!value.startsWith('S')) {
        throw new Error(`${name} must be a Stellar secret key beginning with S...`)
    }
}

function formatQuote(data: unknown): string {
    // Provider A returns { pair, price, timestamp }
    const d = data as { pair?: string; price?: string; timestamp?: string }
    return `pair=${d.pair ?? '?'}  price=${d.price ?? '?'}  ts=${d.timestamp ?? '?'}`
}

async function main(): Promise<void> {
    requireSecret('AGENT_SECRET', AGENT_SECRET)

    const client = new RouteDockClient({
        wallet: AGENT_SECRET,
        network: STELLAR_NETWORK,
        // Optional: cap daily spend at $0.10 so runaway loops can't drain the wallet.
        spendCap: { daily: '0.10', asset: 'USDC' },
    })

    console.log(`[client] network=${STELLAR_NETWORK}`)
    console.log(`[client] provider=${PRICE_URL}`)
    console.log(`[client] fetching ${QUOTE_COUNT} price quotes via x402\n`)

    for (let i = 1; i <= QUOTE_COUNT; i++) {
        // forceMode: 'x402' bypasses the default mpp-charge preference so the
        // example clearly demonstrates the x402 path. Remove forceMode in
        // production to let the SDK pick the cheapest available mode.
        const result = await client.pay(PRICE_URL, { forceMode: 'x402' })

        console.log(
            `#${String(i).padStart(2, '0')} | ${formatQuote(result.data)}` +
            `  txHash=${result.txHash ?? 'n/a'}  paid=${result.amount} USDC`,
        )
    }

    console.log(`\n[done] fetched ${QUOTE_COUNT} quotes — each settled as a separate x402 transaction`)
}

main().catch((err) => {
    console.error('[fatal]', err)
    process.exit(1)
})
