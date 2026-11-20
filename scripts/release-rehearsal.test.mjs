import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const ci = read('../.github/workflows/ci.yml')
const release = read('../.github/workflows/release.yml')
const dependabot = read('../.github/dependabot.yml')
const script = read('./release-rehearsal.sh')
const validator = read('./check-release-tags.mjs')

test('release.yml and the CI gate use the same release script', () => {
  assert.match(release, /publish:\s*bash scripts\/release-rehearsal\.sh\s*$/m)
  assert.match(ci, /^  release-rehearsal:\s*$/m)
  assert.match(ci, /RELEASE_REHEARSAL=1 bash scripts\/release-rehearsal\.sh/)
})

test('the shared script exercises the real publish command and the tag contract', () => {
  assert.match(script, /^if \[\[ "\$rehearsal" != "1" \]\]; then/m)
  assert.match(script, /pnpm run release/)
  assert.match(script, /verdaccio@6/)
  assert.match(script, /npm_config_registry/)
  assert.match(script, /npm view "\$spec" version/)
  assert.match(script, /node scripts\/check-release-tags\.mjs "\$stdout_log" "\$\{publishable\[@\]\}"/)
})

test('the tag validator fails on v3 output and names the missing lines', () => {
  assert.match(validator, /New tag:\\s\+/)
  assert.match(validator, /Missing 'New tag:' lines/)
  assert.match(validator, /process\.exit\(1\)/)
  assert.match(ci, /node --test scripts\/check-release-tags\.test\.mjs/)
})

test('the rehearsal needs no secrets and never uplinks @routedock packages', () => {
  const routedockUplink = script.match(/'@routedock\/\*':([\s\S]*?)'\*\*':/)
  assert.ok(routedockUplink, 'the Verdaccio config must have a @routedock/* rule')
  assert.doesNotMatch(routedockUplink[1], /proxy:/)

  const job = ci.match(/^  release-rehearsal:\n([\s\S]*?)(?=^  [a-z-]+:\n)/m)
  assert.ok(job, 'the release-rehearsal job must exist')
  assert.doesNotMatch(job[1], /secrets\./)
  assert.match(job[1], /contents: read/)
})

test('Dependabot is pinned below the changesets v3 stdout break', () => {
  const lines = dependabot.split('\n')
  const index = lines.findIndex((line) => line.includes('@changesets/cli'))
  assert.ok(index >= 0, 'the ignore entry must exist')
  assert.match(lines.slice(index, index + 3).join('\n'), /version-update:semver-major/)
})
