export const dynamic = 'force-dynamic'

import { Zap, Repeat2, Waves, GitBranch, Timer, Shield } from 'lucide-react'
import { getSupabaseServerClient } from '@/lib/supabase'
import type { TxLogEntry } from '@/lib/supabase'
import { PublicNav } from '@/components/layout/PublicNav'
import { PublicFooter } from '@/components/layout/PublicFooter'
import { HeroCodeBlock } from '@/components/landing/HeroCodeBlock'
import { ModeCard } from '@/components/landing/ModeCard'
import { LiveFeed } from '@/components/landing/LiveFeed'
import { FadeInUp } from '@/components/landing/FadeInUp'

async function fetchInitialFeed(): Promise<TxLogEntry[]> {
  try {
    const supabase = getSupabaseServerClient()
    const { data } = await supabase
      .from('tx_log')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(5)
    return (data ?? []) as TxLogEntry[]
  } catch {
    return []
  }
}

export default async function LandingPage() {
  const initialFeed = await fetchInitialFeed()

  return (
    <div className="min-h-screen bg-[var(--bg-base)] text-[var(--text-primary)]">
      <PublicNav />

      {/* ── HERO ─────────────────────────────────────────────────────────── */}
      <section className="relative min-h-screen flex items-center justify-center overflow-hidden pt-16">
        {/* Mesh gradient background */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(ellipse 80% 60% at 50% -10%, rgba(56,189,248,0.08) 0%, transparent 60%), radial-gradient(ellipse 60% 50% at 80% 60%, rgba(99,102,241,0.06) 0%, transparent 60%)',
          }}
        />

        <div className="relative mx-auto max-w-4xl px-4 sm:px-6 text-center py-32">
          {/* Label chip */}
          <div className="mb-8 inline-flex items-center gap-2 rounded-full border border-[var(--accent)]/30 bg-[var(--accent)]/5 px-4 py-1.5 text-sm text-[var(--accent)]">
            <Zap className="h-3.5 w-3.5" />
            Built for the Stellar Agent Economy
          </div>

          {/* H1 */}
          <h1 className="text-3xl sm:text-5xl md:text-7xl font-bold leading-[1.08] tracking-tight mb-6">
            One interface.
            <br className="hidden sm:block" />
            <span className="sm:hidden"> </span>
            Three payment modes.
            <br className="hidden sm:block" />
            <span className="sm:hidden"> </span>
            <span className="text-[var(--accent)]">Zero hardcoding.</span>
          </h1>

          <p className="mx-auto max-w-2xl text-base sm:text-lg text-[var(--text-secondary)] mb-10 leading-relaxed px-2">
            x402, MPP charge, and MPP session — unified behind{' '}
            <code className="font-mono text-[var(--text-primary)] bg-white/5 rounded px-1.5 py-0.5 text-sm">
              client.pay(url)
            </code>
            . Your agent discovers the endpoint, selects the mode, and pays. You write nothing
            else.
          </p>

          {/* Code block — the hero artifact */}
          <div className="mx-auto max-w-2xl mb-10 text-left overflow-x-auto">
            <HeroCodeBlock />
          </div>

          {/* CTA row */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-3 px-2">
            <code className="inline-flex items-center gap-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-subtle)] px-3 sm:px-4 py-2.5 text-xs sm:text-sm font-mono text-[var(--text-primary)] max-w-full overflow-x-auto">
              npm install @routedock/routedock
            </code>
            <a
              href="/docs"
              className="inline-flex items-center gap-2 rounded-lg border border-[var(--border-default)] bg-transparent px-4 py-2.5 text-sm font-medium text-[var(--text-primary)] hover:bg-[var(--bg-subtle)] transition-colors"
            >
              Read the Docs →
            </a>
          </div>
        </div>
      </section>

      {/* ── PROBLEM ──────────────────────────────────────────────────────── */}
      <section id="features" className="py-32 border-t border-[var(--border-default)]">
        <div className="mx-auto max-w-5xl px-4 sm:px-6">
          <FadeInUp>
            <p className="text-center text-xs font-medium uppercase tracking-widest text-[var(--text-muted)] mb-4">
              The problem
            </p>
            <h2 className="text-center text-3xl sm:text-4xl font-bold mb-16">
              <code className="font-mono text-[var(--accent)]">pay()</code>{' '}
              wasn&apos;t enough
            </h2>
          </FadeInUp>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
            {[
              {
                stat: '3',
                label: 'separate SDKs',
                detail: 'to use x402, MPP charge, and MPP session on Stellar',
              },
              {
                stat: '0',
                label: 'discovery layer',
                detail: 'for MPP endpoints. Zero. Agents must hardcode every URL.',
              },
              {
                stat: '1',
                label: 'unaudited contract',
                detail:
                  'one-way-channel exists but has no safe integration path',
              },
            ].map((item, i) => (
              <FadeInUp key={item.stat} delay={i * 0.06}>
                <div className="rounded-2xl border border-[var(--status-error)]/20 bg-[var(--status-error)]/5 p-6">
                  <div className="text-3xl sm:text-5xl font-bold text-[var(--status-error)] mb-3">
                    {item.stat}
                  </div>
                  <div className="text-base font-semibold text-[var(--text-primary)] mb-1">
                    {item.label}
                  </div>
                  <p className="text-sm text-[var(--text-muted)]">{item.detail}</p>
                </div>
              </FadeInUp>
            ))}
          </div>

          <FadeInUp delay={0.18}>
            <p className="text-center mt-12 text-lg font-semibold text-[var(--text-primary)]">
              RouteDock solves all three.
            </p>
          </FadeInUp>
        </div>
      </section>

      {/* ── SOLUTION ─────────────────────────────────────────────────────── */}
      <section className="py-32 border-t border-[var(--border-default)]">
        <div className="mx-auto max-w-5xl px-4 sm:px-6">
          <FadeInUp>
            <p className="text-center text-xs font-medium uppercase tracking-widest text-[var(--text-muted)] mb-4">
              The solution
            </p>
            <h2 className="text-center text-3xl sm:text-4xl font-bold mb-4">
              The right payment mode, selected automatically
            </h2>
            <p className="text-center text-[var(--text-muted)] mb-16 max-w-2xl mx-auto">
              RouteDock reads the provider&apos;s manifest and picks the optimal mode for each
              access pattern. No configuration. No guessing.
            </p>
          </FadeInUp>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <FadeInUp delay={0}>
              <ModeCard
                mode="x402"
                title="Pay per request"
                description="One HTTP call, one on-chain settlement via OpenZeppelin Channels. Ideal for data queries where you need a result once."
                icon={<Zap className="h-5 w-5" />}
                stats="~0.001 USDC · 1 settlement per request"
              />
            </FadeInUp>
            <FadeInUp delay={0.06}>
              <ModeCard
                mode="mpp-charge"
                title="Pay per action"
                description="Native Stellar SAC transfer. No facilitator needed. Lower fee, faster settlement, fully on-chain with no third-party dependency."
                icon={<Repeat2 className="h-5 w-5" />}
                stats="~0.0008 USDC · SAC transfer per call"
              />
            </FadeInUp>
            <FadeInUp delay={0.12}>
              <ModeCard
                mode="mpp-session"
                title="Pay per time"
                description="Deposit once, stream 1000 interactions, settle once. Off-chain vouchers between open and close — 2 transactions, any number of events."
                icon={<Waves className="h-5 w-5" />}
                stats="0.0001 USDC/voucher · 2 on-chain txs total"
              />
            </FadeInUp>
          </div>
        </div>
      </section>

      {/* ── HOW IT WORKS ─────────────────────────────────────────────────── */}
      <section id="how-it-works" className="py-32 border-t border-[var(--border-default)]">
        <div className="mx-auto max-w-3xl px-4 sm:px-6">
          <FadeInUp>
            <p className="text-center text-xs font-medium uppercase tracking-widest text-[var(--text-muted)] mb-4">
              How it works
            </p>
            <h2 className="text-center text-3xl sm:text-4xl font-bold mb-16">
              Three steps. No ceremony.
            </h2>
          </FadeInUp>

          <div className="space-y-8">
            {[
              {
                step: '01',
                icon: <GitBranch className="h-5 w-5" />,
                title: 'Provider adds middleware + serves routedock.json',
                detail:
                  'One Express middleware call. The SDK validates the manifest at startup. Providers declare their modes, pricing, and payee address once.',
              },
              {
                step: '02',
                icon: <Timer className="h-5 w-5" />,
                title: 'Agent calls client.pay(url)',
                detail:
                  'The SDK fetches the manifest, picks the optimal mode, and pays. For sustained access, openSession() manages the full channel lifecycle.',
              },
              {
                step: '03',
                icon: <Shield className="h-5 w-5" />,
                title: 'On-chain settlement — one tx covers everything',
                detail:
                  'A 50-event MPP session produces 2 transactions: open + close. Every settlement is logged with a Stellar transaction hash.',
              },
            ].map((item, i) => (
              <FadeInUp key={item.step} delay={i * 0.06}>
                <div className="flex gap-5">
                  <div className="shrink-0 flex flex-col items-center">
                    <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[var(--accent)]/10 text-[var(--accent)]">
                      {item.icon}
                    </div>
                    {i < 2 && (
                      <div className="mt-2 h-full w-px bg-[var(--border-default)]" />
                    )}
                  </div>
                  <div className="pb-8">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-mono text-[var(--text-muted)]">{item.step}</span>
                      <h3 className="font-semibold text-[var(--text-primary)]">{item.title}</h3>
                    </div>
                    <p className="text-sm text-[var(--text-muted)] leading-relaxed">{item.detail}</p>
                  </div>
                </div>
              </FadeInUp>
            ))}
          </div>
        </div>
      </section>

      {/* ── LIVE DEMO FEED ───────────────────────────────────────────────── */}
      <section className="py-32 border-t border-[var(--border-default)]">
        <div className="mx-auto max-w-3xl px-4 sm:px-6">
          <FadeInUp>
            <p className="text-center text-xs font-medium uppercase tracking-widest text-[var(--text-muted)] mb-4">
              Live demo
            </p>
            <h2 className="text-center text-3xl sm:text-4xl font-bold mb-4">
              It&apos;s live on testnet right now
            </h2>
            <p className="text-center text-[var(--text-muted)] mb-12">
              Every transaction below is a real Stellar testnet settlement.
            </p>
          </FadeInUp>
          <FadeInUp delay={0.06}>
            <LiveFeed initialEntries={initialFeed} />
          </FadeInUp>
        </div>
      </section>

      {/* ── FAQ ──────────────────────────────────────────────────────────── */}
      <section id="faq" className="py-32 border-t border-[var(--border-default)]">
        <div className="mx-auto max-w-3xl px-4 sm:px-6">
          <FadeInUp>
            <h2 className="text-center text-3xl sm:text-4xl font-bold mb-16">FAQ</h2>
          </FadeInUp>

          <div className="space-y-6">
            {[
              {
                q: 'Is the one-way-channel contract audited?',
                a: 'No. It\'s stellar-experimental/one-way-channel. RouteDock wraps it with safe defaults and a durable server-side SessionStore that enforces the monotonic-amount invariant. Production use should await an independent audit.',
              },
              {
                q: 'Do I need XLM for gas?',
                a: 'Not for x402. The OpenZeppelin Channels facilitator sponsors all fees. MPP charge supports server-sponsored paths. Your agent holds only USDC.',
              },
              {
                q: 'What networks are supported?',
                a: 'Stellar testnet and mainnet. Switch via a single STELLAR_NETWORK env var. The SDK, providers, and agent all respect the same flag.',
              },
              {
                q: 'How does endpoint discovery work?',
                a: 'Providers serve routedock.json at /.well-known/routedock.json. The SDK fetches and validates it before every pay() call (60s TTL cache). The Supabase registry indexes manifests with trigram search so agents can query by capability description.',
              },
            ].map((item, i) => (
              <FadeInUp key={i} delay={i * 0.06}>
                <div className="rounded-2xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-6">
                  <h3 className="font-semibold text-[var(--text-primary)] mb-2">{item.q}</h3>
                  <p className="text-sm text-[var(--text-muted)] leading-relaxed">{item.a}</p>
                </div>
              </FadeInUp>
            ))}
          </div>
        </div>
      </section>

      <PublicFooter />
    </div>
  )
}
