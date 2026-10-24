/** Keep standalone Nulth diagnostics behind the optional logger. */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')

function listSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') out.push(...listSourceFiles(full))
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

function consoleLines(source: string): number[] {
  return source.split('\n').flatMap((line, index) => {
    const trimmed = line.trim()
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) {
      return []
    }
    return /\bconsole\s*[.[]/.test(line) ? [index + 1] : []
  })
}

describe('Nulth logging (#575)', () => {
  it('detects direct and computed console access', () => {
    // #given a positive control using both forms
    const source = "console.warn('warning')\nconsole['warn']('warning')"
    // #when scanned #then both calls are rejected
    assert.deepEqual(consoleLines(source), [1, 2])
  })

  it('has no bare console usage in production sources', () => {
    // #given all production TypeScript files
    const files = listSourceFiles(SRC)
    assert.ok(files.length > 0)
    // #when scanned #then diagnostics only use the configured logger
    const offenders = files.flatMap((file) =>
      consoleLines(readFileSync(file, 'utf8')).map((line) => `${relative(SRC, file)}:${line}`),
    )
    assert.deepEqual(offenders, [], 'Route diagnostics through NulthClientConfig.logger')
  })
})
