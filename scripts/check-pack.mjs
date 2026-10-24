import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Validate the actual npm file list, not the contents of the build directory. */
export function checkPack(packageDir, packedFiles) {
  const manifest = JSON.parse(readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  const files = new Set(packedFiles.map(({ path: name }) => name));
  const errors = [];
  const allowed = new Set(['package.json', 'README.md', 'LICENSE']);
  for (const file of files) {
    if (!file.startsWith('dist/') && !allowed.has(file)) {
      errors.push(`Disallowed file: ${file}`);
    }
  }

  function target(value, field, isBin = false) {
    if (typeof value !== 'string') return;
    const filename = value.replace(/^\.\//, '');
    if (!files.has(filename)) {
      errors.push(`Missing ${field} target: ${value}`);
    } else if (isBin) {
      const firstLine = readFileSync(path.join(packageDir, filename), 'utf8').split(/\r?\n/, 1)[0];
      if (firstLine !== '#!/usr/bin/env node') {
        errors.push(`Invalid ${field} shebang: ${value} (expected #!/usr/bin/env node)`);
      }
    }
  }

  for (const field of ['main', 'module', 'types']) target(manifest[field], field);
  if (typeof manifest.bin === 'string') target(manifest.bin, 'bin', true);
  else for (const [name, value] of Object.entries(manifest.bin ?? {})) target(value, `bin.${name}`, true);

  function exports(value, field) {
    if (typeof value === 'string') target(value, field);
    else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) exports(child, `${field}.${key}`);
    }
  }
  exports(manifest.exports, 'exports');
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const packageDir = process.argv[2];
  const packed = JSON.parse(readFileSync(0, 'utf8'));
  if (!Array.isArray(packed) || packed.length !== 1 || !Array.isArray(packed[0].files)) {
    throw new Error('Expected the npm pack file list for exactly one package');
  }
  const errors = checkPack(packageDir, packed[0].files);
  for (const error of errors) console.error(`ERROR: ${packageDir}: ${error}`);
  if (errors.length) process.exitCode = 1;
}
