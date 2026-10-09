import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft, Package, Server, Bot, Shield, Search, Terminal, type LucideIcon } from 'lucide-react'
import { DOCS_MANIFEST_EXAMPLE } from '@/lib/docsManifestExample'

export const metadata: Metadata = {
  title: 'Docs',
  description: 'RouteDock SDK documentation — agent client, provider middleware, manifest standard, and contract account policies.',
}

function Section({ id, icon: Icon, title, children }: { id: string; icon: LucideIcon; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24">
      <div className="flex items-center gap-3 mb-4">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--accent-subtle)]">
          <Icon className="h-4 w-4 text-[var(--accent)]" />
        </div>
        <h2 className="text-xl font-semibold text-[var(--text-primary)]">{title}</h2>
      </div>
      <div className="space-y-4 text-sm text-[var(--text-secondary)] leading-relaxed">
        {children}
      </div>
    </section>
  )
}

function Code({ children }: { children: string }) {
  return (
    <pre className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] p-4 overflow-x-auto">
      <code className="text-xs font-mono text-[var(--text-primary)] whitespace-pre">{children}</code>
    </pre>
  )
}

function InlineCode({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-[var(--bg-subtle)] px-1.5 py-0.5 text-xs font-mono text-[var(--accent)]">{children}</code>
}

const NAV = [
  { id: 'install', label: 'Install' },
  { id: 'agent-client', label: 'Agent Client' },
  { id: 'provider-middleware', label: 'Provider Middleware' },
  { id: 'manifest', label: 'Manifest Standard' },
  { id: 'mode-selection', label: 'Mode Selection' },
  { id: 'session-lifecycle', label: 'Session Lifecycle' },
  { id: 'contract-account', label: 'Contract Account' },
  { id: 'discovery', label: 'Discovery Registry' },
  { id: 'env-vars', label: 'Environment Variables' },
]

export default function DocsPage() {
  return (
    <div className="min-h-screen bg-[var(--bg-base)]">
      <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6 lg:px-8">
        <div className="mb-8">
          <Link href="/" className="inline-flex items-center gap-2 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors">
            <ArrowLeft className="h-4 w-4" />
            Back to home
          </Link>
        </div>

        <div className="lg:grid lg:grid-cols-[220px_1fr] lg:gap-12">
          {/* Sidebar nav */}
          <nav className="hidden lg:block sticky top-24 self-start">
            <ul className="space-y-1">
              {NAV.map((item) => (
                <li key={item.id}>
                  <a
                    href={`#${item.id}`}
                    className="block rounded-md px-3 py-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-subtle)] transition-colors"
                  >
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          {/* Content */}
          <div className="space-y-16">
            <div>
              <h1 className="text-3xl font-bold text-[var(--text-primary)] mb-2">Documentation</h1>
              <p className="text-[var(--text-secondary)]">
                Everything you need to integrate RouteDock into your agent or provider service.
              </p>
            </div>

            <Section id="install" icon={Package} title="Install">
              <Code>{`npm install @routedock/routedock`}</Code>
              <p>
                The package ships ESM and CJS dual builds with full TypeScript declarations.
                Subpath imports keep your bundle small:
              </p>
              <Code>{`import { RouteDockClient } from '@routedock/routedock'               // types + client
import { RouteDockClient } from '@routedock/routedock/client'        // client only
import { routedock } from '@routedock/routedock/provider'             // Express middleware + handlers
import { routedockHono } from '@routedock/routedock/provider/hono'    // Hono middleware
import { routedockFastify } from '@routedock/routedock/provider/fastify' // Fastify plugin
import { useRouteDockClient, usePay } from '@routedock/routedock/react' // React hooks
import { createMockRoutedockMiddleware } from '@routedock/routedock/testing' // Test utilities
import schema from '@routedock/routedock/schema'                      // Canonical manifest JSON Schema`}</Code>
              <p>
                Peer dependencies (<InlineCode>express</InlineCode>, <InlineCode>hono</InlineCode>, <InlineCode>fastify</InlineCode>, <InlineCode>react</InlineCode>) are all optional — only install what your application imports.
              </p>
            </Section>

            <Section id="agent-client" icon={Bot} title="Agent Client">
              <p>
                The agent client handles <InlineCode>x402</InlineCode> and <InlineCode>mpp-charge</InlineCode> through <InlineCode>pay()</InlineCode> and channels through <InlineCode>openSession()</InlineCode>.
              </p>
              <Code>{`import { RouteDockClient } from '@routedock/routedock'
import { Keypair } from '@stellar/stellar-sdk'

const client = new RouteDockClient({
  wallet: Keypair.fromSecret(process.env.AGENT_SECRET),
  network: 'testnet',
  spendCap: { daily: '1.00', asset: 'USDC' },         // optional local guard
  commitmentSecret: process.env.COMMITMENT_SECRET,      // required for mpp-session
})

// One-shot payment — mode selected automatically from manifest
const result = await client.pay('https://provider.example.com/price')
// result.data   — response body
// result.txHash — on-chain settlement hash
// result.mode   — 'x402' | 'mpp-charge'
// result.amount — amount paid

// Sustained streaming access via payment channel (SSE or WebSocket)
const session = await client.openSession('https://provider.example.com/stream', {
  mode: 'mpp-session-ws', // or 'mpp-session' (SSE)
})
for await (const update of session.stream()) {
  console.log(update)
  if (done) break
}
const closeResult = await session.close()
// closeResult.closeTxHash — on-chain settlement hash
// closeResult.totalPaid   — cumulative USDC paid
// closeResult.vouchersIssued — number of off-chain vouchers`}</Code>
            </Section>

            <Section id="provider-middleware" icon={Server} title="Provider Middleware">
              <p>
                Middleware adapters sign and serve the manifest at <InlineCode>/.well-known/routedock.json</InlineCode>, verify payments across supported modes, and settle on-chain.
              </p>
              <p><strong>Express:</strong></p>
              <Code>{`import express from 'express'
import { routedock } from '@routedock/routedock/provider'

const app = express()

app.use(routedock({
  modes: ['x402', 'mpp-charge'],
  pricing: { x402: '0.001', 'mpp-charge': '0.0008' },
  asset: 'USDC',
  assetContract: process.env.USDC_ASSET_CONTRACT,
  payee: process.env.STELLAR_PAYEE_ADDRESS,
  payeeSecretKey: process.env.STELLAR_PAYEE_SECRET,
  network: process.env.STELLAR_NETWORK,
  facilitatorApiKey: process.env.OPENZEPPELIN_API_KEY,  // mainnet x402 only
  manifest,
  onSettled: async (txHash, amount, mode) => {
    console.log(\`Settled: \${mode} \${amount} USDC — \${txHash}\`)
  },
}))

app.get('/price', async (req, res) => {
  // This only runs after payment is verified
  res.json({ price: '0.199', pair: 'XLM/USDC' })
})`}</Code>

              <p className="mt-4"><strong>Hono (Cloudflare Workers / Node):</strong></p>
              <p className="text-sm text-[var(--text-muted)]">
                Mount at <InlineCode>&apos;*&apos;</InlineCode> so RouteDock serves the signed manifest at <InlineCode>/.well-known/routedock.json</InlineCode> automatically (as mounted in <InlineCode>apps/provider-a/src/worker.ts</InlineCode>):
              </p>
              <Code>{`import { Hono } from 'hono'
import { routedockHono } from '@routedock/routedock/provider/hono'

const app = new Hono()
app.use(
  '*',
  routedockHono({
    modes: ['x402', 'mpp-charge'],
    pricing: { x402: '0.001', 'mpp-charge': '0.0008' },
    asset: 'USDC',
    assetContract: process.env.USDC_ASSET_CONTRACT,
    payee: process.env.STELLAR_PAYEE_ADDRESS,
    payeeSecretKey: process.env.STELLAR_PAYEE_SECRET,
    network: process.env.STELLAR_NETWORK,
    manifest,
    onSettled: async (txHash, amount, mode, payer) => {
      console.log(\`Settled: \${mode} \${amount} USDC — \${txHash}\`)
    },
  })
)

app.get('/price', (c) => c.json({ price: '0.199', pair: 'XLM/USDC' }))`}</Code>

              <p className="mt-4"><strong>Fastify:</strong></p>
              <Code>{`import Fastify from 'fastify'
import { routedockFastify } from '@routedock/routedock/provider/fastify'

const fastify = Fastify()
await fastify.register(
  routedockFastify({
    modes: ['x402', 'mpp-charge'],
    pricing: { x402: '0.001', 'mpp-charge': '0.0008' },
    asset: 'USDC',
    assetContract: process.env.USDC_ASSET_CONTRACT,
    payee: process.env.STELLAR_PAYEE_ADDRESS,
    payeeSecretKey: process.env.STELLAR_PAYEE_SECRET,
    network: process.env.STELLAR_NETWORK,
    manifest,
    onSettled: async (txHash, amount, mode) => {
      console.log(\`Settled: \${mode} \${amount} USDC — \${txHash}\`)
    },
  })
)

fastify.get('/price', async () => ({ price: '0.199', pair: 'XLM/USDC' }))`}</Code>

              <p>
                On testnet, x402 uses a local <InlineCode>ExactStellarFacilitatorScheme</InlineCode> —
                no third-party dependency. On mainnet, it routes to the OpenZeppelin hosted facilitator automatically.
              </p>
            </Section>

            <Section id="manifest" icon={Search} title="Manifest Standard">
              <p>
                Every provider serves <InlineCode>/.well-known/routedock.json</InlineCode>. Provider adapters sign the manifest with <InlineCode>payeeSecretKey</InlineCode> using Ed25519. Clients validate the manifest against the JSON Schema (draft-07 via <InlineCode>@cfworker/json-schema</InlineCode>) and reject any manifest that fails schema validation or whose <InlineCode>signature_version</InlineCode> is not <InlineCode>&quot;2&quot;</InlineCode> (see <InlineCode>packages/sdk/src/manifest/sign.ts</InlineCode> line 97) before making any payment.
              </p>
              <Code>{JSON.stringify(DOCS_MANIFEST_EXAMPLE, null, 2)}</Code>
              <p>
                The canonical JSON Schema is exported from <InlineCode>@routedock/routedock/schema</InlineCode> (source file at <InlineCode>packages/sdk/src/schemas/routedock.schema.json</InlineCode>). Providers can validate manifests in automated test suites (see <InlineCode>apps/provider-a/src/__tests__/manifest.test.ts</InlineCode> for the canonical test pattern with Ajv). Modes retained solely for backwards compatibility can be flagged in <InlineCode>deprecated_modes</InlineCode>.
              </p>
            </Section>

            <Section id="mode-selection" icon={Terminal} title="Mode Selection">
              <p>
                Deterministic, manifest-driven mode selection (implemented in <InlineCode>packages/sdk/src/client/ModeRouter.ts</InlineCode>):
              </p>
              <ol className="list-decimal list-inside space-y-2 pl-1">
                <li><strong>Forced mode override:</strong> If <InlineCode>{'{ forceMode }'}</InlineCode> is specified, that mode is used directly (throws <InlineCode>RouteDockNoSupportedModeError</InlineCode> if unsupported by the provider, and logs a warning if deprecated).</li>
                <li><strong>Active before deprecated:</strong> Modes declared in <InlineCode>deprecated_modes</InlineCode> are only evaluated as a fallback if no active supported mode matches the criteria.</li>
                <li><strong>Session modes:</strong> With <InlineCode>{'{ sustained: true }'}</InlineCode> or <InlineCode>{'{ session: true }'}</InlineCode>, selection picks a session mode by <InlineCode>transport</InlineCode>:
                  <ul className="list-disc list-inside space-y-1 pl-4 mt-1">
                    <li><InlineCode>{'transport: \'websocket\''}</InlineCode> prefers <InlineCode>mpp-session-ws</InlineCode>, falling back to <InlineCode>mpp-session</InlineCode>.</li>
                    <li><InlineCode>{'transport: \'sse\''}</InlineCode> (or default) prefers <InlineCode>mpp-session</InlineCode>, falling back to <InlineCode>mpp-session-ws</InlineCode>.</li>
                  </ul>
                  To open one, call <InlineCode>{'client.openSession(url, { mode })'}</InlineCode>. It uses the mode you pass and defaults to <InlineCode>mpp-session</InlineCode>.
                </li>
                <li><strong>Cost optimization:</strong> When <InlineCode>{'optimize: \'cost\''}</InlineCode> is set, the client compares amounts across candidate per-request modes (<InlineCode>x402</InlineCode>, <InlineCode>mpp-charge</InlineCode>) and picks the cheapest. If <InlineCode>budget_per_request</InlineCode> is provided and all candidates exceed it, throws <InlineCode>RouteDockPolicyRejectError</InlineCode>.</li>
                <li><strong>Default discrete precedence (<InlineCode>client.pay</InlineCode>):</strong>
                  <ul className="list-disc list-inside space-y-1 pl-4 mt-1">
                    <li>Prefers <InlineCode>mpp-charge</InlineCode> — native SAC transfer (lower fees, no facilitator).</li>
                    <li>Falls back to <InlineCode>x402</InlineCode> with facilitator.</li>
                    <li>Throws <InlineCode>RouteDockNoSupportedModeError</InlineCode> if no supported mode is available.</li>
                  </ul>
                </li>
              </ol>
              <p className="mt-3 text-xs text-[var(--text-muted)]">
                Note: <InlineCode>client.pay()</InlineCode> only executes discrete payments (<InlineCode>x402</InlineCode> or <InlineCode>mpp-charge</InlineCode>). If a session mode is selected for discrete payment, it throws an error instructing the caller to use <InlineCode>client.openSession()</InlineCode>.
              </p>
            </Section>

            <Section id="session-lifecycle" icon={Terminal} title="Session Lifecycle (MPP Channel)">
              <p>The MPP session mode uses the <InlineCode>stellar-experimental/one-way-channel</InlineCode> Soroban contract.</p>
              <ol className="list-decimal list-inside space-y-2 pl-1">
                <li>Channel deployed with USDC deposit, commitment key, recipient, refund window (17280 ledgers)</li>
                <li>Each interaction: agent signs cumulative ed25519 commitment off-chain — no RPC call, no tx fee</li>
                <li>Server verifies by simulating <InlineCode>prepare_commitment</InlineCode> on the contract (read-only)</li>
                <li>On close: server calls <InlineCode>{'close(amount, signature)'}</InlineCode> — one Soroban tx settles everything</li>
              </ol>
              <p className="mt-3">
                50 interactions, 2 on-chain transactions. Each voucher costs zero gas. The channel contract
                enforces settlement via <InlineCode>ed25519_verify</InlineCode> on Soroban.
              </p>
            </Section>

            <Section id="contract-account" icon={Shield} title="Contract Account (Agent Vault)">
              <p>
                The agent vault at <InlineCode>contracts/agent-vault/</InlineCode> uses the
                Crossmint <InlineCode>stellar-smart-account</InlineCode> pattern. Three policies run
                inside <InlineCode>__check_auth</InlineCode>:
              </p>
              <ul className="list-disc list-inside space-y-2 pl-1">
                <li><strong>Daily cap</strong> — rejects if <InlineCode>current_day_spend + amount {'>'} daily_cap</InlineCode></li>
                <li><strong>Endpoint allowlist</strong> — rejects transfers to addresses not in the stored allowlist</li>
                <li><strong>Session key expiry</strong> — rejects if the current ledger exceeds the expiry ledger</li>
              </ul>
              <p className="mt-3">
                These are consensus-layer guarantees — Soroban rejects the transaction before broadcast.
                The agent cannot overspend even if the SDK is compromised.
              </p>
            </Section>

            <Section id="discovery" icon={Search} title="Discovery Registry">
              <p>
                The Supabase <InlineCode>providers</InlineCode> table indexes manifests with
                <InlineCode>pg_trgm</InlineCode> trigram search. Agents can query by capability:
              </p>
              <Code>{`SELECT * FROM providers
WHERE name % 'streaming price feed'
ORDER BY similarity(name, 'streaming price feed') DESC`}</Code>
              <p>
                Tags, description, and manifest JSON are all indexed. No exact keyword matching required.
              </p>
            </Section>

            <Section id="env-vars" icon={Terminal} title="Environment Variables">
              <p><strong>Provider:</strong></p>
              <Code>{`STELLAR_NETWORK=testnet              # or mainnet
STELLAR_PAYEE_SECRET=S...            # server keypair
STELLAR_PAYEE_ADDRESS=G...           # derived from above
OPENZEPPELIN_API_KEY=...             # mainnet x402 only
USDC_ASSET_CONTRACT=CBIELTK6...      # testnet USDC SAC
SUPABASE_URL=https://...supabase.co
SUPABASE_SERVICE_KEY=eyJ...          # never expose to clients
CHANNEL_CONTRACT_ID=C...             # mpp-session only
COMMITMENT_PUBLIC_KEY=G...           # mpp-session only`}</Code>
              <p className="mt-4"><strong>Agent:</strong></p>
              <Code>{`STELLAR_NETWORK=testnet
AGENT_SECRET=S...
COMMITMENT_SECRET=S...               # ed25519 key for signing vouchers
AGENT_DAILY_CAP_USDC=0.002
PROVIDER_A_URL=http://localhost:3001
PROVIDER_B_URL=http://localhost:3002`}</Code>
              <p className="mt-4"><strong>Dashboard:</strong></p>
              <Code>{`NEXT_PUBLIC_SUPABASE_URL=https://...supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
NEXT_PUBLIC_STELLAR_NETWORK=testnet`}</Code>
            </Section>
          </div>
        </div>
      </div>
    </div>
  )
}
