/**
 * Issue #286 guard: every SDK diagnostic must go through a `RouteDockLogger`
 * so consumers can silence, redirect, or structure it. The only module allowed
 * to touch `console` is the console-backed default logger itself.
 *
 * This is enforced as a test (rather than a lint rule) so it runs alongside the
 * rest of the suite on every platform, including CI without ESLint.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const ALLOWED = new Set([join('internal', 'logger.ts')])

function listSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue
      out.push(...listSourceFiles(full))
      continue
    }
    if (!entry.name.endsWith('.ts')) continue
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) continue
    out.push(full)
  }
  return out
}

describe('SDK logging (#286)', () => {
  it('has no bare console usage outside the default logger', () => {
    const offenders: string[] = []

    for (const file of listSourceFiles(SRC)) {
      const rel = relative(SRC, file)
      if (ALLOWED.has(rel)) continue

      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          const trimmed = line.trim()
          // Skip comment lines (the remaining `console.` mentions are docs).
          if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
            return
          }
          if (/\bconsole\s*\./.test(line)) {
            offenders.push(`${rel}:${index + 1}: ${trimmed}`)
          }
        })
    }

    assert.deepEqual(
      offenders,
      [],
      `Bare console usage found — route it through a RouteDockLogger instead:\n${offenders.join('\n')}`,
    )
  })
})
