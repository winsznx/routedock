import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Validator, type Schema } from '@cfworker/json-schema'
import schema from '../schemas/routedock.schema.json' with { type: 'json' }
import { assertManifestValid } from '../client/ModeRouter.js'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const validator = new Validator(schema as unknown as Schema, '7')

function markdownManifests(source: string): unknown[] {
  return [...source.matchAll(/```json\s*([\s\S]*?)```/g)]
    .map((match) => match[1]!)
    .filter((block) => block.includes('"routedock"'))
    .map((block) => JSON.parse(block))
}

function seedManifests(source: string): unknown[] {
  return [...source.matchAll(/'(\{[\s\S]*?\})'::jsonb/g)]
    .map((match) => match[1]!)
    .filter((block) => block.includes('"routedock"'))
    .map((block) => JSON.parse(block))
}

function validate(sourceName: string, manifests: unknown[]): void {
  assert.ok(manifests.length > 0, `${sourceName} did not yield a manifest`)
  for (const manifest of manifests) {
    const result = validator.validate(manifest)
    assert.equal(result.valid, true, `${sourceName}: ${result.errors.map((error) => error.error).join('; ')}`)
    assertManifestValid(manifest as Parameters<typeof assertManifestValid>[0])
  }
}

test('documented and seeded manifests remain valid SDK manifests', async () => {
  const [readme, docs, seed] = await Promise.all([
    readFile(join(repoRoot, 'README.md'), 'utf8'),
    readFile(join(repoRoot, 'docs/MANIFEST.md'), 'utf8'),
    readFile(join(repoRoot, 'supabase/seed.sql'), 'utf8'),
  ])

  validate('README.md', markdownManifests(readme))
  validate('docs/MANIFEST.md', markdownManifests(docs))
  validate('supabase/seed.sql', seedManifests(seed))
})
