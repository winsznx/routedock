import { test } from 'node:test'
import assert from 'node:assert/strict'
import { missingTags, parseNewTags, NEW_TAG_REGEX } from './release-rehearsal.mjs'

const expected = [
  { name: '@routedock/mcp-server', version: '0.2.4' },
  { name: '@routedock/nulth-sdk', version: '0.3.1' },
  { name: '@routedock/routedock', version: '0.4.2' },
]

// What @changesets/cli 2.31.1 prints from `changeset publish`.
const v2Output = `
🦋  info npm info @routedock/mcp-server
🦋  info @routedock/mcp-server is being published because our local version (0.2.4) has not been published on npm
🦋  success packages published successfully:
🦋  @routedock/mcp-server@0.2.4
🦋  @routedock/nulth-sdk@0.3.1
🦋  @routedock/routedock@0.4.2
🦋  Creating git tag...
🦋  New tag:  @routedock/mcp-server@0.2.4
🦋  New tag:  @routedock/nulth-sdk@0.3.1
🦋  New tag:  @routedock/routedock@0.4.2
`

// What @changesets/cli 3.0.3 prints: same publish, but "Created git tags:".
const v3Output = `
🦋  success packages published successfully:
🦋  @routedock/mcp-server@0.2.4
🦋  @routedock/nulth-sdk@0.3.1
🦋  @routedock/routedock@0.4.2
🦋  Created git tags:
🦋  - @routedock/mcp-server@0.2.4
🦋  - @routedock/nulth-sdk@0.3.1
🦋  - @routedock/routedock@0.4.2
`

test('parses scoped New tag lines the way changesets/action does', () => {
  assert.deepEqual(parseNewTags(v2Output), expected)
})

test('accepts unscoped package names too', () => {
  assert.deepEqual(parseNewTags('New tag: left-pad@1.2.3\n'), [{ name: 'left-pad', version: '1.2.3' }])
  assert.match('New tag: left-pad@1.2.3', NEW_TAG_REGEX)
})

test('no packages are missing when every package has a New tag line', () => {
  assert.deepEqual(missingTags(v2Output, expected), [])
})

test('the @changesets/cli 3 output format reports every package as missing', () => {
  assert.deepEqual(missingTags(v3Output, expected), expected)
})

test('a single package without a New tag line is reported by name and version', () => {
  const partial = v2Output.replace('🦋  New tag:  @routedock/nulth-sdk@0.3.1\n', '')
  assert.deepEqual(missingTags(partial, expected), [{ name: '@routedock/nulth-sdk', version: '0.3.1' }])
})

test('a New tag line for a different version does not satisfy the expectation', () => {
  const stale = v2Output.replace('New tag:  @routedock/routedock@0.4.2', 'New tag:  @routedock/routedock@0.4.1')
  assert.deepEqual(missingTags(stale, expected).map((e) => e.name), ['@routedock/routedock'])
})
