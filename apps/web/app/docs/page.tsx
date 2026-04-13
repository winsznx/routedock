import type { Metadata } from 'next'
import Link from 'next/link'
import { ArrowLeft, Package, Server, Bot, Shield, Search, Terminal } from 'lucide-react'

export const metadata: Metadata = {
  title: 'Docs',
  description: 'RouteDock SDK documentation — agent client, provider middleware, manifest standard, and contract account policies.',
}

function Section({ id, icon: Icon, title, children }: { id: string; icon: React.ComponentType<{ className?: string }>; title: string; children: React.ReactNode }) {
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
              <Code>{`import { RouteDockClient } from '@routedock/routedock'        // types + client
import { RouteDockClient } from '@routedock/routedock/client' // client only
import { routedock } from '@routedock/routedock/provider'      // provider only`}</Code>
              <p>
                Peer dependency: <InlineCode>express@^4.18.0</InlineCode> (for provider middleware).
              </p>
            </Section>

            <Section id="agent-client" icon={Bot} title="Agent Client">
              <p>The agent client wraps all three payment modes behind a single function call.</p>
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
// result.txHash — settlement hash (or null for session vouchers)
// result.mode   — 'x402' | 'mpp-charge' | 'mpp-session'
// result.amount — amount paid

// Sustained streaming access via payment channel
const session = await client.openSession('https://provider.example.com/stream')
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
              <p>One Express middleware handles all three payment modes, serves the manifest, and settles on-chain.</p>
              <Code>{`import express from 'express'
import { routedock } from '@routedock/routedock/provider'

const app = express()

app.use('/price', routedock({
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
              <p>
                On testnet, x402 uses a local <InlineCode>ExactStellarFacilitatorScheme</InlineCode> —
                no third-party dependency. On mainnet, it routes to the OpenZeppelin hosted facilitator automatically.
              </p>
            </Section>

            <Section id="manifest" icon={Search} title="Manifest Standard">
              <p>
                Every provider serves <InlineCode>/.well-known/routedock.json</InlineCode>. The SDK fetches
                and validates it against a JSON Schema (AJV, draft-07) before every call.
              </p>
              <Code>{`{
  "routedock": "1.0",
  "name": "Stellar DEX Price Feed",
  "modes": ["x402", "mpp-charge"],
  "network": "testnet",
  "asset": "USDC",
  "asset_contract": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  "payee": "G...",
  "pricing": {
    "x402": { "amount": "0.001", "per": "request" },
    "mpp-charge": { "amount": "0.0008", "per": "request" }
  },
  "endpoints": { "price": "GET /price" },
  "tags": ["price", "stellar", "dex"]
}`}</Code>
              <p>
                The JSON Schema lives at <InlineCode>packages/sdk/src/schemas/routedock.schema.json</InlineCode>.
                Providers validate the manifest at startup — invalid manifests prevent the server from starting.
              </p>
            </Section>

            <Section id="mode-selection" icon={Terminal} title="Mode Selection">
              <p>Deterministic, manifest-driven, no randomness:</p>
              <ol className="list-decimal list-inside space-y-2 pl-1">
                <li>If caller passes <InlineCode>{'{ sustained: true }'}</InlineCode> and manifest supports <InlineCode>mpp-session</InlineCode> → open payment channel</li>
                <li>Else if manifest supports <InlineCode>mpp-charge</InlineCode> → native SAC transfer (lower fees, no facilitator)</li>
                <li>Else if manifest supports <InlineCode>x402</InlineCode> → x402 with facilitator</li>
                <li>Else throw <InlineCode>RouteDockNoSupportedModeError</InlineCode></li>
              </ol>
              <p className="mt-3">
                Override with <InlineCode>{'{ forceMode: \'x402\' }'}</InlineCode> to bypass automatic selection.
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
NEXT_PUBLIC_STELLAR_NETWORK=testnet
NEXT_PUBLIC_STELLAR_EXPERT_URL=https://stellar.expert/explorer/testnet`}</Code>
            </Section>
          </div>
        </div>
      </div>
    </div>
  )
}
