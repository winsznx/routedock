import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const script = fileURLToPath(new URL('./check-release-tags.mjs', import.meta.url))
const packages = [
  '@routedock/mcp-server',
  '@routedock/nulth-sdk',
  '@routedock/routedock',
]

function check(log) {
  const dir = mkdtempSync(join(tmpdir(), 'release-tags-'))
  try {
    const file = join(dir, 'publish.log')
    writeFileSync(file, log)
    return spawnSync(process.execPath, [script, file, ...packages], { encoding: 'utf8' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('accepts the v2 publish output the release workflow depends on', () => {
  const result = check([
    'info: uploading @routedock/mcp-server',
    'New tag:  @routedock/mcp-server@0.2.4',
    'New tag:  @routedock/nulth-sdk@0.3.1',
    'New tag:  @routedock/routedock@0.4.2',
    '',
  ].join('\n'))
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.match(result.stdout, /Found 3 'New tag:' lines/)
})

test('accepts the colored butterfly-prefixed lines changesets really prints', () => {
  const result = check([
    '\u001b[36m🦋\u001b[39m  New tag:  @routedock/mcp-server@0.2.4',
    '\u001b[36m🦋\u001b[39m  New tag:  @routedock/nulth-sdk@0.3.1',
    '\u001b[36m🦋\u001b[39m  New tag:  @routedock/routedock@0.4.2',
    '',
  ].join('\n'))
  assert.equal(result.status, 0, result.stderr + result.stdout)
  assert.match(result.stdout, /Found 3 'New tag:' lines/)
})

test('rejects the v3 output and names every missing New tag line', () => {
  const result = check([
    'info: uploading @routedock/mcp-server',
    'Created git tags:',
    '- @routedock/mcp-server@0.2.4',
    '- @routedock/nulth-sdk@0.3.1',
    '- @routedock/routedock@0.4.2',
    '',
  ].join('\n'))
  assert.equal(result.status, 1, result.stderr + result.stdout)
  assert.match(result.stderr, /Missing 'New tag:' lines/)
  for (const pkg of packages) assert.match(result.stderr, new RegExp(pkg.replace('/', '\\/')))
})

test('rejects a partial publish and names only the missing package', () => {
  const result = check([
    'New tag:  @routedock/mcp-server@0.2.4',
    'New tag:  @routedock/routedock@0.4.2',
    '',
  ].join('\n'))
  assert.equal(result.status, 1, result.stderr + result.stdout)
  assert.match(result.stderr, /@routedock\/nulth-sdk \(found 0\)/)
  assert.doesNotMatch(result.stderr, /@routedock\/mcp-server \(found/)
})

test('rejects unexpected extra tags', () => {
  const result = check([
    ...packages.map((pkg) => `New tag:  ${pkg}@1.0.0`),
    'New tag:  @routedock/extra@1.0.0',
    '',
  ].join('\n'))
  assert.equal(result.status, 1, result.stderr + result.stdout)
  assert.match(result.stderr, /expected exactly 3 'New tag:' lines, found 4/)
})
