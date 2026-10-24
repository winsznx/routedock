import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { checkPack } from './check-pack.mjs';

function fixture(t, overrides = {}, omitted = [], files = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'routedock-pack-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const manifest = {
    name: 'routedock-pack-fixture', version: '1.0.0', files: ['dist'],
    main: './dist/index.js', module: 'dist/index.mjs', types: './dist/index.d.ts',
    bin: { fixture: 'dist/cli.js' },
    exports: { '.': { import: { types: './dist/index.d.ts', default: './dist/index.mjs' }, require: './dist/index.js' }, './hono': ['./dist/provider/hono.cjs'], './private': null },
    ...overrides,
  };
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest));
  const output = { 'dist/index.js': 'module.exports = {}', 'dist/index.mjs': 'export {}', 'dist/index.d.ts': 'export {}', 'dist/cli.js': '#!/usr/bin/env node\n', 'dist/provider/hono.cjs': 'module.exports = {}', ...files };
  for (const [filename, contents] of Object.entries(output)) {
    if (omitted.includes(filename)) continue;
    mkdirSync(path.dirname(path.join(dir, filename)), { recursive: true });
    writeFileSync(path.join(dir, filename), contents);
  }
  const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', dir], { encoding: 'utf8' }));
  return checkPack(dir, packed[0].files);
}

test('accepts a built package with nested conditions, array exports and object bin', t => {
  assert.deepEqual(fixture(t), []);
});
test('names every missing entry point in an empty build', t => {
  const errors = fixture(t, { files: [] }, ['dist/index.js', 'dist/index.mjs', 'dist/index.d.ts', 'dist/cli.js', 'dist/provider/hono.cjs']);
  assert(errors.some(e => e.includes('Missing main target: ./dist/index.js')));
  assert(errors.some(e => e.includes('Missing module target: dist/index.mjs')));
  assert(errors.some(e => e.includes('Missing types target: ./dist/index.d.ts')));
  assert(errors.some(e => e.includes('Missing bin.fixture target: dist/cli.js')));
  assert(errors.some(e => e.includes('exports...import.default')));
});
test('names a missing individual nested export', t => {
  assert.deepEqual(fixture(t, {}, ['dist/provider/hono.cjs']), ['Missing exports../hono.0 target: ./dist/provider/hono.cjs']);
});
test('rejects files outside the publication allowlist', t => {
  assert.deepEqual(fixture(t, { files: ['dist', 'secret.txt'] }, [], { 'secret.txt': 'do not ship' }), ['Disallowed file: secret.txt']);
});
test('rejects an executable without the Node shebang', t => {
  assert.match(fixture(t, {}, [], { 'dist/cli.js': 'console.log("hello")' }).join('\n'), /Invalid bin.fixture shebang/);
});
test('validates string bin targets and rejects a shebang lookalike', t => {
  assert.deepEqual(fixture(t, { bin: 'dist/cli.js' }), []);
  assert.match(fixture(t, { bin: 'dist/cli.js' }, [], { 'dist/cli.js': '#!/usr/bin/env node-other\n' }).join('\n'), /Invalid bin shebang/);
});
test('checks the npm pack list even when an excluded target exists on disk', t => {
  assert.match(fixture(t, { files: ['dist/index.js'] }).join('\n'), /Missing module target/);
});
