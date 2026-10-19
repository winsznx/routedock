/**
 * agent/src/stress.ts
 *
 * RouteDock stress harness. Runs in three modes:
 *
 *   probe        — always. Unauthenticated GETs against both deployed providers:
 *                  the signed manifest, and an unpaid request to each paid route.
 *   paid         — when AGENT_SECRET is set. Real x402 and mpp-charge payments.
 *   paid+session — when AGENT_SECRET and COMMITMENT_SECRET are both set. Opens a
 *                  real mpp-session against provider-b, streams vouchers, closes.
 *
 * Every sample's `ok` comes from an HTTP status or an SDK result — nothing is
 * simulated. The report is written to docs/STRESS_TEST.md and the raw samples to
 * docs/stress-results/latest.json, both relative to the repo root (the script
 * runs from the agent/ workspace, so paths are resolved from this file).
 *
 * Run from the repo root:
 *   pnpm stress:test
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Keypair } from '@stellar/stellar-sdk'
import { RouteDockClient } from '@routedock/routedock'

// ── Paths ────────────────────────────────────────────────────────────────────
// Resolve output paths from this file so a filtered pnpm run (cwd = agent/)
// still writes to the repo root.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const DOCS_DIR = path.join(REPO_ROOT, 'docs')
const RESULTS_DIR = path.join(DOCS_DIR, 'stress-results')

// ── Config ───────────────────────────────────────────────────────────────────
const RAW_STELLAR_NETWORK = process.env['STELLAR_NETWORK'] ?? 'testnet'
if (RAW_STELLAR_NETWORK !== 'testnet' && RAW_STELLAR_NETWORK !== 'mainnet') {
  console.error(
    `STELLAR_NETWORK must be "testnet" or "mainnet", got "${RAW_STELLAR_NETWORK}"`,
  )
  process.exit(1)
}
const STELLAR_NETWORK: 'testnet' | 'mainnet' = RAW_STELLAR_NETWORK
const AGENT_SECRET = process.env['AGENT_SECRET'] ?? ''
const COMMITMENT_SECRET = process.env['COMMITMENT_SECRET'] ?? ''
const PROVIDER_A_URL = (process.env['PROVIDER_A_URL'] ?? 'https://api-a.routedock.xyz').replace(/\/$/, '')
const PROVIDER_B_URL = (process.env['PROVIDER_B_URL'] ?? 'https://api-b.routedock.xyz').replace(/\/$/, '')
const CONCURRENT_AGENTS = parseInt(process.env['CONCURRENT_AGENTS'] ?? '50', 10)
const PAYMENTS_PER_SESSION = parseInt(process.env['PAYMENTS_PER_SESSION'] ?? '10', 10)

// ── Types ────────────────────────────────────────────────────────────────────
type Phase =
  | 'manifest-get'
  | 'stream-unpaid'
  | 'price-unpaid'
  | 'x402-paid'
  | 'mpp-charge-paid'
  | 'session-open'
  | 'session-voucher'
  | 'session-close'

type ForceMode = 'x402' | 'mpp-charge'

interface Sample {
  phase: Phase
  ms: number
  ok: boolean
  error?: string
}

const ALL_PHASES: Phase[] = [
  'manifest-get',
  'stream-unpaid',
  'price-unpaid',
  'x402-paid',
  'mpp-charge-paid',
  'session-open',
  'session-voucher',
  'session-close',
]

// ── Helpers ──────────────────────────────────────────────────────────────────
const t = () => performance.now()

function sample(phase: Phase, ms: number, ok: boolean, error?: string): Sample {
  return error ? { phase, ms, ok, error } : { phase, ms, ok }
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'UnknownError'
}

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  return Math.round(sorted[Math.ceil((p / 100) * sorted.length) - 1]!)
}

function stats(samples: Sample[], phase: Phase) {
  const hits = samples.filter((s) => s.phase === phase)
  const ok = hits.filter((s) => s.ok).map((s) => s.ms).sort((a, b) => a - b)
  return {
    phase,
    n: hits.length,
    successPct: hits.length ? Math.round((ok.length / hits.length) * 100) : 0,
    p50: pct(ok, 50),
    p95: pct(ok, 95),
    p99: pct(ok, 99),
    min: ok[0] ?? 0,
    max: ok[ok.length - 1] ?? 0,
  }
}

async function get(url: string): Promise<{ status: number; ms: number }> {
  const t0 = t()
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    return { status: r.status, ms: t() - t0 }
  } catch {
    return { status: 0, ms: t() - t0 }
  }
}

async function getHealth(baseUrl: string): Promise<{ status: number; network?: string }> {
  try {
    const r = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(15_000) })
    if (!r.ok) return { status: r.status }
    const body = (await r.json()) as { network?: unknown }
    return typeof body.network === 'string'
      ? { status: r.status, network: body.network }
      : { status: r.status }
  } catch {
    return { status: 0 }
  }
}

// ── Probe mode ───────────────────────────────────────────────────────────────
async function probeAgent(): Promise<Sample[]> {
  const out: Sample[] = []

  {
    const r = await get(`${PROVIDER_B_URL}/.well-known/routedock.json`)
    out.push(sample('manifest-get', r.ms, r.status === 200, r.status === 200 ? undefined : `HTTP ${r.status}`))
  }

  {
    // The paid route must answer an unpaid request with exactly 402.
    const r = await get(`${PROVIDER_B_URL}/stream/orderbook`)
    out.push(sample('stream-unpaid', r.ms, r.status === 402, r.status === 402 ? undefined : `HTTP ${r.status}`))
  }

  {
    const r = await get(`${PROVIDER_A_URL}/price`)
    out.push(sample('price-unpaid', r.ms, r.status === 402, r.status === 402 ? undefined : `HTTP ${r.status}`))
  }

  return out
}

// ── Paid mode ────────────────────────────────────────────────────────────────
async function paidCall(
  client: RouteDockClient,
  url: string,
  forceMode: ForceMode,
  phase: Phase,
): Promise<Sample> {
  const t0 = t()
  try {
    const result = await client.pay(url, { forceMode })
    const ok = result.txHash != null
    return sample(phase, t() - t0, ok, ok ? undefined : 'NullTxHash')
  } catch (err) {
    return sample(phase, t() - t0, false, errorName(err))
  }
}

async function runPaid(client: RouteDockClient): Promise<Sample[]> {
  const out: Sample[] = []
  for (let i = 0; i < PAYMENTS_PER_SESSION; i++) {
    out.push(await paidCall(client, `${PROVIDER_A_URL}/price`, 'x402', 'x402-paid'))
  }
  for (let i = 0; i < PAYMENTS_PER_SESSION; i++) {
    out.push(await paidCall(client, `${PROVIDER_A_URL}/price`, 'mpp-charge', 'mpp-charge-paid'))
  }
  return out
}

// ── Session mode ─────────────────────────────────────────────────────────────
async function runSession(client: RouteDockClient): Promise<Sample[]> {
  const out: Sample[] = []

  type Session = Awaited<ReturnType<RouteDockClient['openSession']>>
  let session: Session | undefined

  const tOpen = t()
  try {
    session = await client.openSession(`${PROVIDER_B_URL}/stream/orderbook`)
    out.push(sample('session-open', t() - tOpen, true))
  } catch (err) {
    out.push(sample('session-open', t() - tOpen, false, errorName(err)))
  }

  if (!session) return out
  const open = session

  let vouchers = 0
  let last = t()
  try {
    for await (const _item of open.stream()) {
      const now = t()
      out.push(sample('session-voucher', now - last, true))
      last = now
      if (++vouchers >= PAYMENTS_PER_SESSION) break
    }
  } catch (err) {
    out.push(sample('session-voucher', t() - last, false, errorName(err)))
  } finally {
    const tClose = t()
    try {
      const close = await open.close()
      const closed = close.closeTxHash != null
      out.push(sample('session-close', t() - tClose, closed, closed ? undefined : 'NullTxHash'))
    } catch (err) {
      out.push(sample('session-close', t() - tClose, false, errorName(err)))
    }
  }

  return out
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const healthB = await getHealth(PROVIDER_B_URL)
  const healthA = await getHealth(PROVIDER_A_URL)
  const network = healthB.network ?? STELLAR_NETWORK

  const paidEnabled = AGENT_SECRET !== ''
  const sessionEnabled = paidEnabled && COMMITMENT_SECRET !== ''
  const mode = sessionEnabled ? 'paid+session' : paidEnabled ? 'paid' : 'probe'

  console.log(`\nRouteDock stress test — mode=${mode}, agents=${CONCURRENT_AGENTS}\n`)

  const notRun: Array<{ phase: Phase; reason: string }> = []
  const all: Sample[] = []

  const wall0 = t()

  const settled = await Promise.allSettled(
    Array.from({ length: CONCURRENT_AGENTS }, () => probeAgent()),
  )
  for (const r of settled) {
    if (r.status === 'fulfilled') all.push(...r.value)
    else all.push(sample('manifest-get', 0, false, errorName(r.reason)))
  }

  if (paidEnabled) {
    const client = new RouteDockClient({
      wallet: Keypair.fromSecret(AGENT_SECRET),
      network: STELLAR_NETWORK,
      commitmentSecret: COMMITMENT_SECRET || undefined,
    })
    all.push(...(await runPaid(client)))
    if (sessionEnabled) {
      all.push(...(await runSession(client)))
    } else {
      const reason = 'COMMITMENT_SECRET not set'
      notRun.push(
        { phase: 'session-open', reason },
        { phase: 'session-voucher', reason },
        { phase: 'session-close', reason },
      )
    }
  } else {
    const paidReason = 'AGENT_SECRET not set'
    notRun.push(
      { phase: 'x402-paid', reason: paidReason },
      { phase: 'mpp-charge-paid', reason: paidReason },
    )
    const sessionReason = 'AGENT_SECRET and COMMITMENT_SECRET not set'
    notRun.push(
      { phase: 'session-open', reason: sessionReason },
      { phase: 'session-voucher', reason: sessionReason },
      { phase: 'session-close', reason: sessionReason },
    )
  }

  const wallMs = t() - wall0

  // Any enabled phase that produced no samples (e.g. openSession failed before
  // the stream) is reported as not run, so the report never implies coverage.
  for (const phase of ALL_PHASES) {
    if (all.some((s) => s.phase === phase)) continue
    if (notRun.some((n) => n.phase === phase)) continue
    notRun.push({ phase, reason: 'no samples recorded' })
  }

  const ranPhases = ALL_PHASES.filter((p) => all.some((s) => s.phase === p))
  const table = ranPhases.map((p) => stats(all, p))

  // Console table
  console.log('Phase            n     ok%   p50   p95   p99   min   max')
  console.log('-'.repeat(60))
  for (const r of table) {
    console.log(
      `${r.phase.padEnd(16)} ${String(r.n).padStart(4)}  ${String(r.successPct).padStart(4)}%  ${String(r.p50).padStart(4)}  ${String(r.p95).padStart(4)}  ${String(r.p99).padStart(4)}  ${String(r.min).padStart(4)}  ${String(r.max).padStart(4)}`,
    )
  }
  for (const n of notRun) {
    console.log(`${n.phase.padEnd(16)} not run — ${n.reason}`)
  }
  console.log(`\nTotal time: ${(wallMs / 1000).toFixed(2)}s\n`)

  const runAt = new Date().toISOString()
  const rows = table
    .map(
      (r) =>
        `| ${r.phase} | ${r.n} | ${r.successPct}% | ${r.p50} | ${r.p95} | ${r.p99} | ${r.min} | ${r.max} |`,
    )
    .join('\n')

  const callsPerPhase = `x402-paid=${PAYMENTS_PER_SESSION}, mpp-charge-paid=${PAYMENTS_PER_SESSION}, session-voucher=${PAYMENTS_PER_SESSION}`
  const notRunLines = notRun.length
    ? notRun.map((n) => `- \`${n.phase}\` — ${n.reason}`).join('\n')
    : '_Every phase ran._'
  const healthLine = (h: { status: number; network?: string }) =>
    `HTTP ${h.status}${h.network ? ` (network: ${h.network})` : ''}`

  const md = `# RouteDock Stress Test (${network})

## Run

| | |
|---|---|
| runAt | ${runAt} |
| Mode | ${mode} |
| Agents | ${CONCURRENT_AGENTS} |
| Calls per phase | ${callsPerPhase} |
| Provider A | \`${PROVIDER_A_URL}\` |
| Provider B | \`${PROVIDER_B_URL}\` |
| Health A | ${healthLine(healthA)} |
| Health B | ${healthLine(healthB)} |
| Wall-clock | ${(wallMs / 1000).toFixed(2)}s |

## Results (ms)

| Phase | n | ok% | p50 | p95 | p99 | min | max |
|---|---|---|---|---|---|---|---|
${rows}

## Not run

${notRunLines}

_Generated by \`agent/src/stress.ts\`_
`

  fs.mkdirSync(RESULTS_DIR, { recursive: true })
  fs.writeFileSync(path.join(DOCS_DIR, 'STRESS_TEST.md'), md)
  console.log('docs/STRESS_TEST.md written')

  fs.writeFileSync(
    path.join(RESULTS_DIR, 'latest.json'),
    JSON.stringify(
      {
        runAt,
        wallMs,
        mode,
        network,
        agents: CONCURRENT_AGENTS,
        callsPerPhase,
        providers: { a: PROVIDER_A_URL, b: PROVIDER_B_URL },
        table,
        raw: all,
        notRun,
      },
      null,
      2,
    ),
  )
  console.log('docs/stress-results/latest.json written\n')

  const failed = all.filter((s) => !s.ok)
  if (failed.length > 0) {
    console.error(`✘ ${failed.length} failed sample(s) across ${ranPhases.length} phase(s)`)
    process.exit(1)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
