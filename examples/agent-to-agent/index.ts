/**
 * agent-to-agent — orchestrator paying a specialist sub-agent
 *
 * An orchestrator agent breaks a task into subtasks and pays a specialist
 * sub-agent for each result using RouteDock's x402 mode.
 *
 * This example runs both agents in a single process for simplicity.
 * In production, each agent is a separate service with its own keypair.
 *
 * Flow:
 *   1. Specialist sub-agent starts an Express-compatible Hono server.
 *   2. Orchestrator fetches the specialist's RouteDock manifest.
 *   3. Orchestrator calls specialist.pay() for each subtask.
 *   4. Specialist verifies x402 payment before returning results.
 *   5. Orchestrator aggregates results and prints the final answer.
 */

import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { Keypair } from '@stellar/stellar-sdk'
import { routedockHono } from '@routedock/sdk/provider/hono'
import { RouteDockClient } from '@routedock/sdk'
import type { RouteDockManifest } from '@routedock/sdk'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const STELLAR_NETWORK = process.env['STELLAR_NETWORK'] === 'mainnet' ? 'mainnet' : 'testnet'
const ORCHESTRATOR_SECRET = process.env['ORCHESTRATOR_SECRET'] ?? ''
const SPECIALIST_SECRET = process.env['SPECIALIST_SECRET'] ?? ''
const START_SPECIALIST = process.env['START_MOCK_SPECIALIST'] !== 'false'
const SPECIALIST_PORT = 3200
const SPECIALIST_URL = `http://localhost:${SPECIALIST_PORT}`

// USDC on Stellar testnet
const USDC_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'

// ---------------------------------------------------------------------------
// Specialist sub-agent server
// ---------------------------------------------------------------------------

function buildSpecialistServer(specialistSecret: string): Hono {
    const specialistKp = Keypair.fromSecret(specialistSecret)

    const manifest: RouteDockManifest = {
        routedock: '1.0',
        name: 'Summariser Specialist',
        description: 'Accepts a text snippet and returns a one-sentence summary — paid per request',
        modes: ['x402'],
        network: STELLAR_NETWORK as 'testnet' | 'mainnet',
        asset: 'USDC',
        asset_contract: USDC_CONTRACT,
        payee: specialistKp.publicKey(),
        pricing: {
            x402: {
                amount: '0.0003',
                per: 'request',
                facilitator: 'https://channels.openzeppelin.com/x402',
            },
        },
        endpoints: { summarise: 'POST /summarise' },
        tags: ['summarise', 'nlp', 'text'],
    }

    const app = new Hono()

    app.use(
        '/summarise',
        routedockHono({
            modes: ['x402'],
            pricing: { x402: manifest.pricing.x402!.amount },
            asset: manifest.asset,
            assetContract: manifest.asset_contract,
            payee: manifest.payee,
            network: manifest.network,
            payeeSecretKey: specialistSecret,
            manifest,
            onSettled: async (txHash, amount, mode) => {
                console.log(`  [specialist] settled  txHash=${txHash}  amount=${amount} USDC  mode=${mode}`)
            },
        }),
    )

    app.post('/summarise', async (c) => {
        const body = await c.req.json<{ text?: string }>().catch(() => ({}))
        const text = body.text ?? ''
        // Canned summarisation — swap for a real LLM call in production.
        const words = text.trim().split(/\s+/).slice(0, 6).join(' ')
        const summary = words.length > 0 ? `Summary: "${words}…"` : 'Summary: (empty input)'
        return c.json({ summary, chars: text.length })
    })

    return app
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

// The orchestrator breaks this document into chunks and pays the specialist
// to summarise each one.
const DOCUMENT_CHUNKS = [
    'Stellar is an open-source, decentralized payment protocol that enables fast, low-cost cross-border transactions using its native asset XLM.',
    'RouteDock is a payment middleware layer for AI agents, enabling micropayments between services using x402 and MPP channel protocols.',
    'The x402 protocol extends HTTP with a 402 Payment Required flow: a client receives payment requirements, signs a payload, and retries the request with the payment header attached.',
]

function requireSecret(name: string, value: string): void {
    if (!value.startsWith('S')) {
        throw new Error(`${name} must be a Stellar secret key beginning with S...`)
    }
}

async function main(): Promise<void> {
    requireSecret('ORCHESTRATOR_SECRET', ORCHESTRATOR_SECRET)
    requireSecret('SPECIALIST_SECRET', SPECIALIST_SECRET)

    let server: ReturnType<typeof serve> | null = null

    if (START_SPECIALIST) {
        const app = buildSpecialistServer(SPECIALIST_SECRET)
        server = serve({ fetch: app.fetch, port: SPECIALIST_PORT })
        console.log(`[specialist] listening on ${SPECIALIST_URL}`)
        await new Promise((r) => setTimeout(r, 50))
    }

    const specialistUrl = `${SPECIALIST_URL}/summarise`

    const orchestrator = new RouteDockClient({
        wallet: ORCHESTRATOR_SECRET,
        network: STELLAR_NETWORK,
        spendCap: { daily: '0.05', asset: 'USDC' },
    })

    console.log(`[orchestrator] network=${STELLAR_NETWORK}`)
    console.log(`[orchestrator] specialist=${specialistUrl}`)
    console.log(`[orchestrator] summarising ${DOCUMENT_CHUNKS.length} document chunks\n`)

    const summaries: string[] = []
    let totalPaid = 0

    for (let i = 0; i < DOCUMENT_CHUNKS.length; i++) {
        const chunk = DOCUMENT_CHUNKS[i]!
        console.log(`#${String(i + 1).padStart(2, '0')} input="${chunk.slice(0, 60)}…"`)

        // Pay the specialist using x402. The orchestrator handles the full
        // 402 → sign → retry cycle automatically.
        const result = await orchestrator.pay(specialistUrl, { forceMode: 'x402' })
        const data = result.data as { summary?: string; chars?: number }

        console.log(`     ${data.summary}`)
        console.log(`     txHash=${result.txHash ?? 'n/a'}  paid=${result.amount} USDC\n`)

        summaries.push(data.summary ?? '')
        totalPaid += parseFloat(result.amount)
    }

    console.log('--- Aggregated summaries ---')
    summaries.forEach((s, i) => console.log(`  ${i + 1}. ${s}`))
    console.log(`\n[orchestrator] total paid to specialist: ${totalPaid.toFixed(4)} USDC`)
    console.log('[done] agent-to-agent task complete')

    if (server) {
        server.close()
    }
}

main().catch((err) => {
    console.error('[fatal]', err)
    process.exit(1)
})
