#!/usr/bin/env node
// Helpers for scripts/release-rehearsal.sh (issue #718).
//
//   node scripts/release-rehearsal.mjs prepare          strip provenance, detach pending changesets,
//                                                       write a throwaway changeset
//   node scripts/release-rehearsal.mjs assert <stdout>  check the publish output and the registry
//
// The release workflow does not read `changeset publish`'s exit status to decide
// what was released: changesets/action scrapes stdout for `New tag:` lines and
// only those packages get a git tag and a GitHub Release. A changesets version
// that stops printing them still publishes to npm and exits 0, so the release
// "succeeds" and the metadata silently disappears. `assert` fails on exactly
// that.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

// Copied verbatim from changesets/action src/run.ts (v1.9.0, a45c4d5). It is the
// contract this rehearsal exists to protect, so keep it identical to the action
// pinned in .github/workflows/release.yml.
export const NEW_TAG_REGEX = /New tag:\s+(@[^/]+\/[^@]+|[^/]+)@([^\s]+)/

/** Non-private workspace packages: what `changeset publish` will try to publish. */
export function publishablePackages(cwd = root) {
  const out = execFileSync('pnpm', ['-r', 'ls', '--json', '--depth', '-1'], {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  return JSON.parse(out)
    .filter((p) => p.name && !p.private)
    .map((p) => ({ name: p.name, path: p.path }))
}

function readVersion(pkgPath) {
  return JSON.parse(readFileSync(join(pkgPath, 'package.json'), 'utf8')).version
}

/**
 * Parse the `New tag:` lines out of `changeset publish`'s stdout the way
 * changesets/action does.
 */
export function parseNewTags(stdout) {
  const tags = []
  for (const line of stdout.split('\n')) {
    const match = line.match(NEW_TAG_REGEX)
    if (match) tags.push({ name: match[1], version: match[2] })
  }
  return tags
}

/**
 * Pure check used by `assert` and by the unit test: returns the expected
 * `name@version` entries that have no `New tag:` line.
 */
export function missingTags(stdout, expected) {
  const seen = new Set(parseNewTags(stdout).map((t) => `${t.name}@${t.version}`))
  return expected.filter((e) => !seen.has(`${e.name}@${e.version}`))
}

/**
 * Make pending changesets look uncommitted. For a committed changeset, or one
 * naming a `pr:` or `commit:`, @changesets/changelog-github queries the GitHub
 * API and fails without GITHUB_TOKEN. Renaming (and dropping those lines) keeps
 * every pending bump in the rehearsed `changeset version` without a token.
 */
export function detachPendingChangesets(dir) {
  const pending = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'README.md')
  for (const file of pending) {
    const text = readFileSync(join(dir, file), 'utf8')
    writeFileSync(
      join(dir, `rehearsal-pending-${file}`),
      text.replace(/^[ \t]*(?:pr|pull|pull[ \t]+request|commit):.*$/gim, ''),
    )
    rmSync(join(dir, file))
  }
  return pending
}

function prepare() {
  const pkgs = publishablePackages()
  if (pkgs.length === 0) throw new Error('no publishable workspace packages found')

  // Provenance needs a GitHub OIDC identity token, which a rehearsal cannot
  // have. Strip it in this workspace only (the CI checkout is disposable).
  for (const { path } of pkgs) {
    const file = join(path, 'package.json')
    const json = JSON.parse(readFileSync(file, 'utf8'))
    if (json.publishConfig && 'provenance' in json.publishConfig) {
      delete json.publishConfig.provenance
      if (Object.keys(json.publishConfig).length === 0) delete json.publishConfig
      writeFileSync(file, JSON.stringify(json, null, 2) + '\n')
    }
  }

  mkdirSync(join(root, '.changeset'), { recursive: true })
  detachPendingChangesets(join(root, '.changeset'))
  const frontmatter = pkgs.map((p) => `"${p.name}": patch`).join('\n')
  writeFileSync(
    join(root, '.changeset', 'release-rehearsal.md'),
    `---\n${frontmatter}\n---\n\nRelease rehearsal (throwaway, never committed).\n`,
  )
  console.log(`rehearsal: ${pkgs.length} publishable package(s): ${pkgs.map((p) => p.name).join(', ')}`)
}

function assertRelease(stdoutFile) {
  const stdout = readFileSync(stdoutFile, 'utf8')
  const registry = process.env.npm_config_registry
  if (!registry) throw new Error('npm_config_registry must point at the throwaway registry')
  if (/registry\.npmjs\.org/.test(registry)) {
    throw new Error('refusing to assert against registry.npmjs.org')
  }

  // Versions are read after `changeset version`, i.e. what was just published.
  const expected = publishablePackages().map((p) => ({ name: p.name, version: readVersion(p.path) }))
  const failures = []

  const missing = missingTags(stdout, expected)
  for (const m of missing) {
    failures.push(`missing "New tag: ${m.name}@${m.version}" line in \`changeset publish\` output`)
  }
  if (missing.length > 0) {
    failures.push(
      `changesets/action only tags and creates a GitHub Release for packages it finds via ` +
        `"New tag:" lines (${NEW_TAG_REGEX}). ${missing.length}/${expected.length} expected ` +
        `package(s) would be published without a tag or Release. A @changesets/cli upgrade ` +
        `that changed this output needs a matching changesets/action change first (#718).`,
    )
  }

  for (const e of expected) {
    try {
      const got = execFileSync('npm', ['view', `${e.name}@${e.version}`, 'version', '--registry', registry], {
        encoding: 'utf8',
        shell: process.platform === 'win32',
      }).trim()
      if (got !== e.version) failures.push(`npm view ${e.name}@${e.version} returned "${got}"`)
    } catch {
      failures.push(`${e.name}@${e.version} was not published to ${registry}`)
    }
  }

  if (failures.length > 0) {
    console.error('::error title=Release rehearsal failed::' + failures[0])
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log(`rehearsal OK: ${expected.length} package(s) published with a "New tag:" line each:`)
  for (const e of expected) console.log(`  - ${e.name}@${e.version}`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [cmd, arg] = process.argv.slice(2)
  if (cmd === 'prepare') prepare()
  else if (cmd === 'assert' && arg) assertRelease(arg)
  else {
    console.error('usage: release-rehearsal.mjs prepare | assert <changeset-publish-stdout-file>')
    process.exit(2)
  }
}
