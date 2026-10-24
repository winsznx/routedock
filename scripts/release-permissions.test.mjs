import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'

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

test('release workflow satisfies the actual CI permission guard', () => {
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
