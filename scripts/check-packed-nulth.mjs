#!/usr/bin/env node
// Exercise published tarballs outside the workspace, including external identity.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temp = mkdtempSync(join(tmpdir(), 'routedock-packed-nulth-'))

function run(command, args, cwd = temp) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: '' },
    timeout: 300_000,
    killSignal: 'SIGKILL',
  })
  if (result.error) throw result.error
  assert.equal(result.status, 0, `${command} ${args.join(' ')}\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}

try {
  const tarballs = ['nulth-sdk', 'sdk'].map((directory) => {
    const cwd = join(root, 'packages', directory)
    const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))
    // pnpm replaces workspace:* with a published version in the packed manifest.
    run('pnpm', ['pack', '--pack-destination', temp], cwd)
    return join(temp, `${pkg.name.replace('@', '').replace('/', '-')}-${pkg.version}.tgz`)
  })

  writeFileSync(join(temp, 'package.json'), JSON.stringify({ private: true }))
  console.log('Installing packed SDKs in a clean directory...')
  run('npm', ['install', '--ignore-scripts', '--prefer-offline', '--no-audit', '--no-fund', '--package-lock=false', ...tarballs])

  const installed = join(temp, 'node_modules', '@routedock')
  const sdk = JSON.parse(readFileSync(join(installed, 'routedock', 'package.json'), 'utf8'))
  const nulth = JSON.parse(readFileSync(join(installed, 'nulth-sdk', 'package.json'), 'utf8'))
  assert.equal(sdk.dependencies['@routedock/nulth-sdk'], nulth.version)

  const smoke = `
    const policy = shared.createPolicyState({
      dailyCapUsdc: '1.00', allowedPayees: ['test-payee'], witnessSecret: 'test-witness',
    })
    for (const sdk of [rootSdk, clientSdk]) {
      for (const name of [
        'createPolicyState', 'paymentContextFromManifest', 'setNulthPaymentContext',
        'decodeAuthSignature', 'NulthPolicyError',
      ]) assert.equal(sdk[name], shared[name], name + ' must come from the external package')

      assert.throws(() => sdk.createNulthSigner({
        nulthAccount: 'test-account', network: 'mainnet', policy,
      }), (error) => error instanceof sdk.RouteDockManifestError &&
        error.cause instanceof shared.NulthConfigError)

      const config = { nulthAccount: 'test-account', network: 'testnet', policy, logger: () => {} }
      const signer = sdk.createNulthSigner(config)
      sdk.setNulthPaymentContext(config, {
        payee: 'test-payee', amountStroops: 1n, assetContract: 'test-asset', ledgerSequence: 1,
      })
      await assert.rejects(signer.signAuthEntry('invalid'), (error) =>
        error instanceof shared.NulthPolicyError && error.code === 'auth_entry_mismatch')
    }
  `

  writeFileSync(join(temp, 'smoke.mjs'), `
    import assert from 'node:assert/strict'
    import * as rootSdk from '@routedock/routedock'
    import * as clientSdk from '@routedock/routedock/client'
    import * as shared from '@routedock/nulth-sdk'
    ${smoke}
    console.log('ESM external dependency OK')
  `)
  writeFileSync(join(temp, 'smoke.cjs'), `
    const assert = require('node:assert/strict')
    const rootSdk = require('@routedock/routedock')
    const clientSdk = require('@routedock/routedock/client')
    const shared = require('@routedock/nulth-sdk')
    async function main() { ${smoke} }
    main().then(() => console.log('CommonJS external dependency OK')).catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
  `)
  run(process.execPath, ['smoke.mjs'])
  run(process.execPath, ['smoke.cjs'])
  console.log('Packed Nulth dependency: ESM and CommonJS OK')
} finally {
  rmSync(temp, { recursive: true, force: true })
}
