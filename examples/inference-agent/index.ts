/**
 * inference-agent — MPP charge payment example
 *
 * Starts a mock Hono inference provider (optional), then pays for three
 * inference requests using the mpp-charge protocol.
 *
 * Flow:
 *   1. Mock provider spins up at localhost:3100 (skipped if START_MOCK_PROVIDER=false).
 *   2. RouteDockClient fetches the provider manifest.
 *   3. For each prompt, client.pay() opens a mpp-charge 402 challenge, signs
 *      the pull-payment, and returns the model response.
 *   4. Each charge settles on-chain independently — no channel required.
 *
 * Run against a live provider by setting:
 *   INFERENCE_PROVIDER_URL=https://your-inference-endpoint.example.com
 *   START_MOCK_PROVIDER=false
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

const INFERENCE_PROVIDER_URL = (process.env['INFERENCE_PROVIDER_URL'] ?? 'http://localhost:3100').replace(/\/$/, '')
const STELLAR_NETWORK = process.env['STELLAR_NETWORK'] === 'mainnet' ? 'mainnet' : 'testnet'
const AGENT_SECRET = process.env['AGENT_SECRET'] ?? ''
const START_MOCK = process.env['START_MOCK_PROVIDER'] !== 'false'
const MOCK_PORT = 3100

// Mock provider keypair — generated fresh each run, no secret hardcoded.
// Provider and client share this keypair within the same process.
const MOCK_PROVIDER_KEYPAIR = Keypair.random()
const MOCK_PROVIDER_SECRET = MOCK_PROVIDER_KEYPAIR.secret()

// USDC on Stellar testnet (Circle's Soroban SAC)
const USDC_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'

// ---------------------------------------------------------------------------
// Mock inference provider (Hono)
// ---------------------------------------------------------------------------

const MANIFEST: RouteDockManifest = {
    routedock: '1.0',
    name: 'Mock Inference Provider',
    description: 'Simulated LLM inference endpoint — returns canned responses',
    modes: ['mpp-charge'],
    network: STELLAR_NETWORK as 'testnet' | 'mainnet',
    asset: 'USDC',
    asset_contract: USDC_CONTRACT,
    payee: MOCK_PROVIDER_KEYPAIR.publicKey(),
    pricing: {
        'mpp-charge': { amount: '0.0005', per: 'request' },
    },
    endpoints: { infer: 'POST /infer' },
    tags: ['inference', 'llm', 'ai'],
}

// Canned responses so the mock needs no real LLM.
const CANNED_RESPONSES: Record<string, string> = {
    default: "I'm a mock inference endpoint. Payment received — here's your canned response.",
    hello: 'Hello! This response was paid for via MPP charge.',
    explain: 'MPP (Metered Payment Protocol) charge enables per-request micropayments without a channel.',
}

function buildMockServer(): Hono {
    const app = new Hono()

    app.use(
        '/infer',
        routedockHono({
            modes: ['mpp-charge'],
            pricing: { 'mpp-charge': MANIFEST.pricing['mpp-charge']!.amount },
            asset: MANIFEST.asset,
            assetContract: MANIFEST.asset_contract,
            payee: MANIFEST.payee,
            network: MANIFEST.network,
            payeeSecretKey: MOCK_PROVIDER_SECRET,
            manifest: MANIFEST,
            onSettled: async (txHash, amount, mode) => {
                console.log(`  [provider] settled  txHash=${txHash}  amount=${amount} USDC  mode=${mode}`)
            },
        }),
    )

    app.post('/infer', async (c) => {
        const body = await c.req.json<{ prompt?: string }>().catch(() => ({}))
        const prompt = (body.prompt ?? '').toLowerCase()
        const key = Object.keys(CANNED_RESPONSES).find((k) => k !== 'default' && prompt.includes(k))
        return c.json({ response: CANNED_RESPONSES[key ?? 'default'], model: 'mock-v1' })
    })

    return app
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

const PROMPTS = [
    'hello',
    'Can you explain what MPP charge is?',
    'What is the capital of France?',
]

function requireSecret(name: string, value: string): void {
    if (!value.startsWith('S')) {
        throw new Error(`${name} must be a Stellar secret key beginning with S...`)
    }
}

async function main(): Promise<void> {
    requireSecret('AGENT_SECRET', AGENT_SECRET)

    let server: ReturnType<typeof serve> | null = null

    if (START_MOCK) {
        const app = buildMockServer()
        server = serve({ fetch: app.fetch, port: MOCK_PORT })
        console.log(`[mock-provider] listening on http://localhost:${MOCK_PORT}`)
        // Give the server a tick to bind before the client connects.
        await new Promise((r) => setTimeout(r, 50))
    }

    const inferUrl = `${INFERENCE_PROVIDER_URL}/infer`

    const client = new RouteDockClient({
        wallet: AGENT_SECRET,
        network: STELLAR_NETWORK,
        spendCap: { daily: '0.10', asset: 'USDC' },
    })

    console.log(`[client] network=${STELLAR_NETWORK}`)
    console.log(`[client] provider=${inferUrl}`)
    console.log(`[client] sending ${PROMPTS.length} inference requests via mpp-charge\n`)

    for (let i = 0; i < PROMPTS.length; i++) {
        const prompt = PROMPTS[i]!
        process.stdout.write(`#${String(i + 1).padStart(2, '0')} prompt="${prompt}"\n`)

        // client.pay() handles the full 402 → sign → retry cycle.
        // mpp-charge is the preferred mode for the mock manifest, so no forceMode needed.
        const result = await client.pay(inferUrl, { forceMode: 'mpp-charge' })
        const data = result.data as { response?: string; model?: string }

        console.log(`     response="${data.response}"`)
        console.log(`     model=${data.model ?? 'unknown'}  txHash=${result.txHash ?? 'n/a'}  paid=${result.amount} USDC\n`)
    }

    console.log(`[done] ${PROMPTS.length} inferences completed via mpp-charge`)

    if (server) {
        server.close()
    }
}

main().catch((err) => {
    console.error('[fatal]', err)
    process.exit(1)
})
