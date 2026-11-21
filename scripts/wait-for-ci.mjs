#!/usr/bin/env node
/**
 * Release CI gate (#724).
 *
 * `release.yml` triggers on push to `main` alongside `ci.yml`. Without this
 * gate, `changesets/action` can publish packages or rewrite the Version
 * Packages PR before CI finishes — or even when CI is red.
 *
 * Polls GitHub's check-runs API for `GITHUB_SHA` until every required CI
 * context from the `main protection` ruleset finishes with `conclusion:
 * 'success'`. Exits 1 immediately if any required check completes with a
 * non-success conclusion or if the timeout elapses, preventing
 * `changesets/action` from running `changeset publish` or `changeset version`.
 */
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** GitHub Actions app integration ID (matches `main protection` ruleset). */
export const GITHUB_ACTIONS_APP_ID = 15368

/** Required CI job contexts from `.github/workflows/ci.yml` and the `main protection` ruleset. */
export const REQUIRED_CI_CONTEXTS = Object.freeze([
  'lint',
  'sdk-tests',
  'app-build',
  'contract-tests',
  'contract-wasm',
  'dependency-audit',
  'actionlint',
  'typecheck',
])

const DEFAULT_POLL_INTERVAL_MS = 15_000
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000

/**
 * Evaluate a commit's check runs against `requiredContexts`.
 *
 * Picks the latest check run (highest numeric `id`) per context so re-runs
 * supersede earlier failed attempts, and ignores non-GitHub-Actions check runs
 * when `app.id` is present.
 */
export function evaluateCheckRuns(checkRuns, requiredContexts = REQUIRED_CI_CONTEXTS) {
  const latestByName = new Map()
  for (const run of checkRuns) {
    if (!run || typeof run.name !== 'string') continue
    if (run.app?.id !== undefined && run.app.id !== GITHUB_ACTIONS_APP_ID) continue
    const prev = latestByName.get(run.name)
    if (!prev || (typeof run.id === 'number' && (typeof prev.id !== 'number' || run.id >= prev.id))) {
      latestByName.set(run.name, run)
    }
  }

  const passed = []
  const failed = []
  const pending = []

  for (const name of requiredContexts) {
    const run = latestByName.get(name)
    if (!run) {
      pending.push({ name, status: 'missing' })
      continue
    }
    if (run.status !== 'completed') {
      pending.push({ name, status: run.status ?? 'unknown' })
      continue
    }
    if (run.conclusion === 'success') {
      passed.push(name)
    } else {
      failed.push({ name, conclusion: run.conclusion ?? 'unknown' })
    }
  }

  const state = failed.length > 0 ? 'failed' : pending.length === 0 ? 'passed' : 'pending'
  return { state, passed, failed, pending }
}

/**
 * Fetch all check runs for `sha` via `gh api --paginate --slurp` so commits
 * with more than 100 historical check runs (e.g. scheduled workflows) are not
 * truncated.
 */
export function fetchCheckRuns(repository, sha, execFile = execFileSync) {
  const raw = execFile(
    'gh',
    ['api', '--paginate', '--slurp', `repos/${repository}/commits/${sha}/check-runs?per_page=100`],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  )
  const pages = JSON.parse(raw)
  if (!Array.isArray(pages)) {
    throw new Error('Unexpected check-runs response shape from gh api')
  }
  return pages.flatMap((page) => (Array.isArray(page?.check_runs) ? page.check_runs : []))
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Poll check runs for `sha` until all `requiredContexts` succeed, any fails,
 * or `timeoutMs` elapses.
 */
export async function waitForCi({
  repository,
  sha,
  requiredContexts = REQUIRED_CI_CONTEXTS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchRuns = fetchCheckRuns,
  sleep = defaultSleep,
  now = Date.now,
  log = console.log,
}) {
  if (!repository || !sha) {
    throw new Error('Both repository (GITHUB_REPOSITORY) and sha (GITHUB_SHA) are required')
  }

  const deadline = now() + timeoutMs
  let lastEval = {
    state: 'pending',
    passed: [],
    failed: [],
    pending: requiredContexts.map((name) => ({ name, status: 'missing' })),
  }
  let lastError = null

  while (true) {
    try {
      const runs = await fetchRuns(repository, sha)
      lastError = null
      lastEval = evaluateCheckRuns(runs, requiredContexts)

      if (lastEval.state === 'passed') {
        log(`CI gate passed for ${sha.slice(0, 8)}: all ${lastEval.passed.length} required checks succeeded.`)
        return { ok: true, passed: lastEval.passed }
      }

      if (lastEval.state === 'failed') {
        const summary = lastEval.failed.map((f) => `${f.name}=${f.conclusion}`).join(', ')
        log(`CI gate blocked release for ${sha.slice(0, 8)}: failed checks (${summary}).`)
        return { ok: false, reason: 'failed', ...lastEval }
      }

      const pendingSummary = lastEval.pending.map((p) => `${p.name}(${p.status})`).join(', ')
      log(
        `Waiting for CI on ${sha.slice(0, 8)}: ${lastEval.passed.length}/${requiredContexts.length} passed; pending: ${pendingSummary}`,
      )
    } catch (error) {
      lastError = error
      log(`Warning: failed to query check-runs for ${sha.slice(0, 8)} (${error instanceof Error ? error.message : String(error)}); retrying...`)
    }

    const remaining = deadline - now()
    if (remaining <= 0) break
    await sleep(Math.min(pollIntervalMs, remaining))
  }

  return { ok: false, reason: 'timeout', ...lastEval, lastError }
}

function parsePositiveInt(raw, fallback) {
  if (raw === undefined || raw === '') return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

function parseCliArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo' && argv[i + 1]) args.repository = argv[++i]
    else if (argv[i] === '--sha' && argv[i + 1]) args.sha = argv[++i]
  }
  return args
}

async function main() {
  const cli = parseCliArgs(process.argv.slice(2))
  const repository = cli.repository ?? process.env.GITHUB_REPOSITORY
  const sha = cli.sha ?? process.env.GITHUB_SHA
  const pollIntervalMs = parsePositiveInt(process.env.WAIT_FOR_CI_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS)
  const timeoutMs = parsePositiveInt(process.env.WAIT_FOR_CI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)

  const result = await waitForCi({ repository, sha, pollIntervalMs, timeoutMs })
  if (!result.ok) {
    if (result.reason === 'failed') {
      const summary = result.failed.map((f) => `${f.name} (${f.conclusion})`).join(', ')
      console.error(`::error::Release blocked: required CI checks failed on ${sha}: ${summary}`)
    } else {
      const pendingSummary = result.pending.map((p) => `${p.name} (${p.status})`).join(', ')
      const errDetail = result.lastError ? `; last error: ${result.lastError.message ?? String(result.lastError)}` : ''
      console.error(`::error::Release blocked: timed out waiting for CI on ${sha}; pending: ${pendingSummary}${errDetail}`)
    }
    process.exit(1)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`::error::CI gate failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  })
}
