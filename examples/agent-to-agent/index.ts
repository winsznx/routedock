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

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import type { MiddlewareHandler } from 'hono'
import { Keypair } from '@stellar/stellar-sdk'
import { routedockHono } from '@routedock/routedock/provider/hono'
import { RouteDockClient } from '@routedock/routedock'
import type { RouteDockManifest } from '@routedock/routedock'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const STELLAR_NETWORK = process.env['STELLAR_NETWORK'] === 'mainnet' ? 'mainnet' : 'testnet'
const ORCHESTRATOR_SECRET = process.env['ORCHESTRATOR_SECRET'] ?? ''
const SPECIALIST_SECRET = process.env['SPECIALIST_SECRET'] ?? ''
const START_SPECIALIST = process.env['START_MOCK_SPECIALIST'] !== 'false'
const SPECIALIST_PORT = 3200
const SPECIALIST_URL = (process.env['SPECIALIST_URL'] ?? `http://localhost:${SPECIALIST_PORT}`).replace(/\/$/, '')

// USDC on Stellar testnet
const USDC_CONTRACT: string =
    process.env['USDC_ASSET_CONTRACT'] ??
    (STELLAR_NETWORK === 'testnet'
        ? 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
        : '')

// ---------------------------------------------------------------------------
// The paid route, shared by the manifest, the server and the client
// ---------------------------------------------------------------------------

/** Path the specialist serves. The manifest, the route and the client all use it. */
export const SUMMARISE_PATH = '/summarise'
/** HTTP method of the paid route. The manifest, the route and the client all use it. */
export const SUMMARISE_METHOD = 'POST'

/** The request the orchestrator sends for one chunk: a JSON body `{ text }`. */
export function buildSummariseRequest(text: string): {
    method: typeof SUMMARISE_METHOD
    headers: Record<string, string>
    body: string
} {
    return {
        method: SUMMARISE_METHOD,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
    }
}

/** The payment middleware slot. Defaults to `routedockHono`; tests inject a stub that settles without a chain. */
export type PaymentGate = MiddlewareHandler

// ---------------------------------------------------------------------------
// Specialist sub-agent server
// ---------------------------------------------------------------------------

export function buildSpecialistManifest(payee: string): RouteDockManifest {
    return {
        routedock: '1.0',
        name: 'Summariser Specialist',
        description: 'Accepts a text snippet and returns a one-sentence summary — paid per request',
        modes: ['x402'],
        network: STELLAR_NETWORK as 'testnet' | 'mainnet',
        asset: 'USDC',
        asset_contract: USDC_CONTRACT,
        payee,
        pricing: {
            x402: {
                amount: '0.0003',
                per: 'request',
                facilitator: 'https://channels.openzeppelin.com/x402',
            },
        },
        endpoints: { summarise: { method: SUMMARISE_METHOD, path: SUMMARISE_PATH } },
        tags: ['summarise', 'nlp', 'text'],
    }
}

export function buildSpecialistServer(
    specialistSecret: string,
    options: { paymentGate?: PaymentGate } = {},
): Hono {
    const specialistKp = Keypair.fromSecret(specialistSecret)
    const manifest = buildSpecialistManifest(specialistKp.publicKey())

    const app = new Hono()

    app.use(options.paymentGate ?? routedockHono({
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

    // Registered for the method the manifest declares and the client sends. The
    // payment middleware settles before it reaches this handler, so a route
    // that does not match would answer the paid request with a 404.
    app.post(SUMMARISE_PATH, async (c) => {
        const body = (await c.req.json().catch(() => null)) as { text?: unknown } | null
        const text = typeof body?.text === 'string' ? body.text : ''
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
    if (!USDC_CONTRACT) {
        throw new Error('USDC_ASSET_CONTRACT is required for mainnet')
    }
    requireSecret('ORCHESTRATOR_SECRET', ORCHESTRATOR_SECRET)
    if (START_SPECIALIST) {
        requireSecret('SPECIALIST_SECRET', SPECIALIST_SECRET)
    }

    let server: ReturnType<typeof serve> | null = null

    if (START_SPECIALIST) {
        const app = buildSpecialistServer(SPECIALIST_SECRET)
        server = serve({ fetch: app.fetch, port: SPECIALIST_PORT })
        console.log(`[specialist] listening on ${SPECIALIST_URL}`)
        await new Promise((r) => setTimeout(r, 50))
    }

    const specialistUrl = `${SPECIALIST_URL}${SUMMARISE_PATH}`

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
        // 402 → sign → retry cycle automatically, replaying the POST body on
        // the unpaid probe and the paid request.
        const result = await orchestrator.pay(specialistUrl, {
            forceMode: 'x402',
            request: buildSummariseRequest(chunk),
        })
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

// Run only when executed directly (node index.ts), not when imported by tests.
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
    main().catch((err) => {
        console.error('[fatal]', err)
        process.exit(1)
    })
}
