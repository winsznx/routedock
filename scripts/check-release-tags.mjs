// Verifies the stdout contract that changesets/action v1.9.0 relies on:
// https://github.com/changesets/action/blob/a45c4d5/src/run.ts#L100-L118
// It scrapes "New tag:" lines and only pushes tags / creates releases for the
// packages it finds there. @changesets/cli v3 prints "Created git tags:"
// instead, which publishes to npm but silently drops all release metadata.
import { readFileSync } from 'node:fs'

const [logPath, ...expected] = process.argv.slice(2)
if (!logPath || expected.length === 0) {
  console.error('usage: node scripts/check-release-tags.mjs <publish-log> <package>...')
  process.exit(2)
}

// Deliberately unanchored: changesets prefixes these lines with its colored
// butterfly logger, and changesets/action's own regex is unanchored too.
const newTagRegex = /New tag:\s+(@[^/]+\/[^@]+|[^/]+)@(\S+)/
const tags = []
for (const line of readFileSync(logPath, 'utf8').split('\n')) {
  const match = line.match(newTagRegex)
  if (match) tags.push({ name: match[1], version: match[2] })
}

const problems = []
for (const pkg of expected) {
  const count = tags.filter((tag) => tag.name === pkg).length
  if (count !== 1) problems.push(`${pkg} (found ${count})`)
}
if (tags.length !== expected.length) {
  problems.push(`expected exactly ${expected.length} 'New tag:' lines, found ${tags.length}`)
}

if (problems.length > 0) {
  console.error(`::error::Missing 'New tag:' lines in \`changeset publish\` output for: ${problems.join(', ')}`)
  console.error("changesets/action v1.9.0 only pushes git tags and creates GitHub Releases for packages announced with 'New tag:' on stdout. Publishing without them silently drops all release metadata (#718).")
  process.exit(1)
}

console.log(`Found ${tags.length} 'New tag:' lines: ${tags.map((tag) => `${tag.name}@${tag.version}`).join(', ')}`)
