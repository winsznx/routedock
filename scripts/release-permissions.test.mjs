import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import {
  GITHUB_ACTIONS_APP_ID,
  REQUIRED_CI_CONTEXTS,
  evaluateCheckRuns,
  fetchCheckRuns,
  waitForCi,
} from './wait-for-ci.mjs'

const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
const release = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
const guardStep = ci.split('      - name: Guard release.yml permissions\n')[1]?.split('\n      - name:')[0]?.split('\n  lint:')[0]
assert.ok(guardStep, 'CI must contain the release permission guard')
const script = guardStep.split('        run: |\n')[1]?.split('\n').filter((line) => line.startsWith('          ')).map((line) => line.slice(10)).join('\n')
assert.ok(script, 'the real CI guard must have an executable shell body')

function guard(workflow) {
  const cwd = mkdtempSync(join(tmpdir(), 'release-permissions-'))
  try {
    mkdirSync(join(cwd, '.github/workflows'), { recursive: true })
    writeFileSync(join(cwd, '.github/workflows/release.yml'), workflow)
    return spawnSync('bash', ['-e', '-c', script], { cwd, encoding: 'utf8' })
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

test('release workflow satisfies the actual CI permission and gate guard', () => {
  const result = guard(release)
  assert.equal(result.status, 0, result.stderr + result.stdout)
})

for (const permission of ['contents', 'pull-requests', 'id-token', 'permission-workflows']) {
  test(`CI rejects a missing ${permission} grant even if comments mention it`, () => {
    const key = new RegExp(`^ +${permission}: *write *$`, 'm')
    assert.match(release, key, 'positive control: the real grant must exist')
    const result = guard(release.replace(key, '') + `\n# ${permission}: write\n`)
    assert.equal(result.status, 1, result.stderr + result.stdout)
    assert.match(result.stdout, new RegExp(permission))
  })
}

test('CI rejects a read-only OIDC permission', () => {
  const result = guard(release.replace('  id-token: write', '  id-token: read'))
  assert.equal(result.status, 1)
  assert.match(result.stdout, /id-token/)
})

test('CI rejects a missing checks: read permission even if comments mention it', () => {
  const key = /^ +checks: *read *$/m
  assert.match(release, key, 'positive control: checks: read must exist')
  const result = guard(release.replace(key, '') + '\n# checks: read\n')
  assert.equal(result.status, 1, result.stderr + result.stdout)
  assert.match(result.stdout, /checks: read/)
})

test('CI rejects release.yml when the wait-for-ci gate is removed, even if comments mention it', () => {
  const gateLine = /^ +run: *node scripts\/wait-for-ci\.mjs *$/m
  assert.match(release, gateLine, 'positive control: the CI gate step must exist')
  const result = guard(release.replace(gateLine, '') + '\n# run: node scripts/wait-for-ci.mjs\n')
  assert.equal(result.status, 1, result.stderr + result.stdout)
  assert.match(result.stdout, /wait-for-ci\.mjs/)
})

test('release.yml runs the CI gate before changesets/action', () => {
  const gateIndex = release.indexOf('run: node scripts/wait-for-ci.mjs')
  const changesetsIndex = release.indexOf('uses: changesets/action@')
  assert.ok(gateIndex > 0, 'wait-for-ci.mjs step must exist in release.yml')
  assert.ok(changesetsIndex > 0, 'changesets/action step must exist in release.yml')
  assert.ok(gateIndex < changesetsIndex, 'Wait for CI must run before changesets/action')
})

test('ci.yml declares merge_group and defines every required CI context', () => {
  const onBlock = ci.split('\njobs:\n')[0]
  assert.match(onBlock, /^  merge_group:\s*$/m, 'ci.yml must trigger on merge_group')
  for (const context of REQUIRED_CI_CONTEXTS) {
    assert.match(
      ci,
      new RegExp(`^  ${context}:\\s*$`, 'm'),
      `ci.yml must keep required job '${context}' stable`,
    )
  }
})

function makeRuns(overrides = {}) {
  return REQUIRED_CI_CONTEXTS.map((name, index) => ({
    id: 100 + index,
    name,
    status: 'completed',
    conclusion: 'success',
    app: { id: GITHUB_ACTIONS_APP_ID },
    ...overrides[name],
  }))
}

test('waitForCi passes once all required CI checks succeed across polling rounds', async () => {
  // #given: checks start missing/in-progress, then complete with success.
  const snapshots = [
    [],
    makeRuns({ 'sdk-tests': { status: 'in_progress', conclusion: null } }),
    makeRuns(),
  ]
  let calls = 0
  let clock = 0
  const sleeps = []

  // #when: polling with a fake clock and sleeper.
  const result = await waitForCi({
    repository: 'winsznx/routedock',
    sha: '3732973000000000000000000000000000000000',
    pollIntervalMs: 10,
    timeoutMs: 100,
    fetchRuns: async () => snapshots[calls++] ?? snapshots.at(-1),
    sleep: async (ms) => {
      sleeps.push(ms)
      clock += ms
    },
    now: () => clock,
    log: () => {},
  })

  // #then: gate succeeds after polling through the pending states.
  assert.equal(result.ok, true)
  assert.equal(calls, 3)
  assert.deepEqual(sleeps, [10, 10])
})

test('waitForCi blocks release immediately when a required CI check fails', async () => {
  // #given: sdk-tests completed with failure while another check is still running.
  let calls = 0
  let slept = false
  const runs = makeRuns({
    'sdk-tests': { status: 'completed', conclusion: 'failure' },
    'app-build': { status: 'in_progress', conclusion: null },
  })

  // #when: waitForCi evaluates the commit.
  const result = await waitForCi({
    repository: 'winsznx/routedock',
    sha: 'feb3c10000000000000000000000000000000000',
    pollIntervalMs: 10,
    timeoutMs: 100,
    fetchRuns: async () => {
      calls++
      return runs
    },
    sleep: async () => {
      slept = true
    },
    now: () => 0,
    log: () => {},
  })

  // #then: gate rejects immediately without sleeping so changeset publish never runs.
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'failed')
  assert.deepEqual(result.failed, [{ name: 'sdk-tests', conclusion: 'failure' }])
  assert.equal(calls, 1)
  assert.equal(slept, false)
})

test('evaluateCheckRuns uses the latest check run per context and ignores non-Actions apps', () => {
  // #given: an earlier failed sdk-tests run superseded by a newer successful re-run,
  // plus a failing check of the same name from a different GitHub App.
  const runs = [
    ...makeRuns(),
    { id: 50, name: 'sdk-tests', status: 'completed', conclusion: 'failure', app: { id: GITHUB_ACTIONS_APP_ID } },
    { id: 999, name: 'sdk-tests', status: 'completed', conclusion: 'success', app: { id: GITHUB_ACTIONS_APP_ID } },
    { id: 1000, name: 'sdk-tests', status: 'completed', conclusion: 'failure', app: { id: 999999 } },
  ]

  // #when / #then: latest GitHub Actions check run wins.
  const evaluated = evaluateCheckRuns(runs)
  assert.equal(evaluated.state, 'passed')
  assert.equal(evaluated.failed.length, 0)
})

test('waitForCi fails closed when required checks never complete before timeout', async () => {
  // #given: contract-wasm remains queued forever.
  let clock = 0
  const runs = makeRuns({ 'contract-wasm': { status: 'queued', conclusion: null } })

  // #when: polling reaches timeoutMs.
  const result = await waitForCi({
    repository: 'winsznx/routedock',
    sha: 'deadbeef00000000000000000000000000000000',
    pollIntervalMs: 10,
    timeoutMs: 25,
    fetchRuns: async () => runs,
    sleep: async (ms) => {
      clock += ms
    },
    now: () => clock,
    log: () => {},
  })

  // #then: gate fails closed with timeout.
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'timeout')
  assert.deepEqual(result.pending, [{ name: 'contract-wasm', status: 'queued' }])
})

test('fetchCheckRuns flattens paginated gh api --paginate --slurp output', () => {
  // #given: two paginated check-runs pages from gh api.
  let invokedArgs = []
  const fakeExec = (_cmd, args) => {
    invokedArgs = args
    return JSON.stringify([
      { total_count: 2, check_runs: [{ id: 1, name: 'lint', status: 'completed', conclusion: 'success' }] },
      { total_count: 2, check_runs: [{ id: 2, name: 'typecheck', status: 'completed', conclusion: 'success' }] },
    ])
  }

  // #when: fetching check runs for a commit.
  const runs = fetchCheckRuns('winsznx/routedock', 'abc123', fakeExec)

  // #then: uses --paginate --slurp and returns all check runs flattened.
  assert.ok(invokedArgs.includes('--paginate'))
  assert.ok(invokedArgs.includes('--slurp'))
  assert.equal(runs.length, 2)
  assert.deepEqual(runs.map((r) => r.name), ['lint', 'typecheck'])
})

test('waitForCi retries transient API errors and succeeds once checks are readable', async () => {
  // #given: the first API call fails transiently, then the second returns all passing checks.
  let calls = 0
  let clock = 0
  const result = await waitForCi({
    repository: 'winsznx/routedock',
    sha: '3732973000000000000000000000000000000000',
    pollIntervalMs: 10,
    timeoutMs: 100,
    fetchRuns: async () => {
      calls++
      if (calls === 1) throw new Error('HTTP 502 Bad Gateway')
      return makeRuns()
    },
    sleep: async (ms) => {
      clock += ms
    },
    now: () => clock,
    log: () => {},
  })

  // #then: recovers on retry and passes.
  assert.equal(result.ok, true)
  assert.equal(calls, 2)
})

