import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '../packages/nulth-sdk')
const readme = readFileSync(join(packageDir, 'README.md'), 'utf8')
const examples = [...readme.matchAll(/```(?:ts|typescript)\r?\n([\s\S]*?)```/g)]
if (examples.length === 0) throw new Error('Nulth README has no TypeScript examples')
const temporary = mkdtempSync(join(packageDir, '.readme-typecheck-'))
try {
  const files = examples.map((match, index) => {
    const filename = join(temporary, `example-${index + 1}.mts`)
    writeFileSync(filename, match[1])
    return filename
  })
  const program = ts.createProgram(files, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: ['node'],
    typeRoots: [join(packageDir, 'node_modules/@types')],
  })
  const diagnostics = ts.getPreEmitDiagnostics(program)
  if (diagnostics.length) {
    process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: () => packageDir,
      getCanonicalFileName: (file) => file,
      getNewLine: () => '\n',
    }))
    process.exitCode = 1
  } else {
    console.log(`Nulth README examples typechecked: ${examples.length}`)
  }
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
