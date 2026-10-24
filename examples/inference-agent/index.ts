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
import { routedockHono } from '@routedock/routedock/provider/hono'
import { RouteDockClient } from '@routedock/routedock'
import type { RouteDockManifest } from '@routedock/routedock'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const INFERENCE_PROVIDER_URL = (process.env['INFERENCE_PROVIDER_URL'] ?? 'http://localhost:3100').replace(/\/$/, '')
const STELLAR_NETWORK = process.env['STELLAR_NETWORK'] === 'mainnet' ? 'mainnet' : 'testnet'
const AGENT_SECRET = process.env['AGENT_SECRET'] ?? ''
const PROVIDER_SECRET = process.env['PROVIDER_SECRET'] ?? ''
const START_MOCK = process.env['START_MOCK_PROVIDER'] !== 'false'
const MOCK_PORT = 3100

// USDC on Stellar testnet (Circle's Soroban SAC)
const USDC_CONTRACT: string =
    process.env['USDC_ASSET_CONTRACT'] ??
    (STELLAR_NETWORK === 'testnet'
        ? 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
        : '')

if (!USDC_CONTRACT) {
    console.error('FATAL: USDC_ASSET_CONTRACT is required for mainnet')
    process.exit(1)
}

// Canned responses so the mock needs no real LLM.
const CANNED_RESPONSES: Record<string, string> = {
    default: "I'm a mock inference endpoint. Payment received — here's your canned response.",
    hello: 'Hello! This response was paid for via MPP charge.',
    explain: 'MPP (Metered Payment Protocol) charge enables per-request micropayments without a channel.',
}

// ---------------------------------------------------------------------------
// Mock inference provider (Hono)
// ---------------------------------------------------------------------------

function buildMockServer(providerSecret: string): Hono {
    const providerKp = Keypair.fromSecret(providerSecret)

    const manifest: RouteDockManifest = {
        routedock: '1.0',
        name: 'Mock Inference Provider',
        description: 'Simulated LLM inference endpoint — returns canned responses',
        modes: ['mpp-charge'],
        network: STELLAR_NETWORK as 'testnet' | 'mainnet',
        asset: 'USDC',
        asset_contract: USDC_CONTRACT,
        payee: providerKp.publicKey(),
        pricing: {
            'mpp-charge': { amount: '0.0005', per: 'request' },
        },
        endpoints: { infer: { method: 'GET', path: '/infer' } },
        tags: ['inference', 'llm', 'ai'],
    }

    const app = new Hono()

    app.use(routedockHono({
            modes: ['mpp-charge'],
            pricing: { 'mpp-charge': manifest.pricing['mpp-charge']!.amount },
            asset: manifest.asset,
            assetContract: manifest.asset_contract,
            payee: manifest.payee,
            network: manifest.network,
            payeeSecretKey: providerSecret,
            manifest,
            onSettled: async (txHash, amount, mode) => {
                console.log(`  [provider] settled  txHash=${txHash}  amount=${amount} USDC  mode=${mode}`)
            },
        }),
    )

    app.get('/infer', async (c) => {
        const prompt = (c.req.query('prompt') ?? '').toLowerCase()
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
        requireSecret('PROVIDER_SECRET', PROVIDER_SECRET)
        const app = buildMockServer(PROVIDER_SECRET)
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
        // client.pay() sends GET with no body, so pass the prompt as a query parameter.
        const url = new URL('/infer', INFERENCE_PROVIDER_URL)
        url.searchParams.set('prompt', prompt)
        const result = await client.pay(url.toString(), { forceMode: 'mpp-charge' })
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
