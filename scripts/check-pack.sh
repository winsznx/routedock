#!/usr/bin/env bash
#
# Package hygiene: everything `npm pack` would publish must live under dist/,
# and every entry point a package advertises must survive into the tarball.
#
# Run after the sdk packages are built, which scripts/verify.sh does:
#
#   pnpm --filter @routedock/nulth-sdk build
#   pnpm --filter @routedock/routedock build
#   bash scripts/check-pack.sh
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

fail() { printf '\n\033[31m✘ %s\033[0m\n' "$1" >&2; exit 1; }
step() { printf '\n\033[36m▸ %s\033[0m\n' "$1"; }

step "packed package contents"

node --input-type=module - <<'NODE' || fail "a published package would ship something it should not, or is missing an entry point"
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const packages = ['packages/sdk', 'packages/nulth-sdk', 'packages/mcp-server']

// npm always includes these regardless of the `files` field.
const alwaysAllowed = new Set(['package.json', 'README.md', 'LICENSE'])

const normalize = (target) => target.replace(/^\.\//, '')

const collectEntryPoints = (manifest) => {
  const wanted = new Set()
  for (const key of ['main', 'module', 'types']) {
    if (typeof manifest[key] === 'string') wanted.add(normalize(manifest[key]))
  }
  for (const targets of Object.values(manifest.exports ?? {})) {
    const list = typeof targets === 'string' ? [targets] : Object.values(targets ?? {})
    for (const target of list) {
      if (typeof target === 'string') wanted.add(normalize(target))
    }
  }
  for (const map of Object.values(manifest.typesVersions ?? {})) {
    for (const targets of Object.values(map ?? {})) {
      for (const target of [].concat(targets)) wanted.add(normalize(target))
    }
  }
  for (const target of Object.values(manifest.bin ?? {})) {
    if (typeof target === 'string') wanted.add(normalize(target))
  }
  return [...wanted].sort()
}

let problems = []

for (const dir of packages) {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))

  let packed
  try {
    packed = JSON.parse(
      execFileSync('npm', ['pack', '--dry-run', '--json'], {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    )
  } catch (error) {
    problems.push(`${dir}: npm pack --dry-run failed. Build the package first. ${error.stderr ?? error}`)
    continue
  }

  const paths = packed[0].files.map((file) => normalize(file.path)).sort()

  for (const file of paths) {
    if (file.startsWith('dist/')) continue
    if (alwaysAllowed.has(file)) continue
    problems.push(`${dir}: ${file} would be published. It is not under dist/ and is not one of ${[...alwaysAllowed].join(', ')}.`)
  }

  const published = new Set([...paths, ...alwaysAllowed])
  const missing = collectEntryPoints(manifest).filter((target) => !published.has(target))
  for (const target of missing) {
    problems.push(`${dir}: entry point ${target} is declared in package.json but is not in the tarball.`)
  }

  const extras = paths.filter((file) => !file.startsWith('dist/'))
  console.log(
    `  ${manifest.name}: ${paths.length} files (${extras.length ? extras.join(', ') : 'dist/ only'})`,
  )
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`  ${problem}`)
  process.exit(1)
}
NODE

printf '\n\033[32m✔ pack check passed\033[0m\n'
