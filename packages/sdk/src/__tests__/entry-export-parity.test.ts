/**
 * Entry export parity — issue #564.
 *
 * `@routedock/routedock` (src/index.ts) and `@routedock/routedock/client`
 * (src/client/index.ts) are two hand-maintained export lists over the same
 * client API.  `MppSessionClient` was published only by the `/client` list, so
 * `import { MppSessionClient } from '@routedock/routedock'` failed even though
 * the READMEs name it as part of the public client surface.
 *
 * Both entries are imported from source (the SDK's own suite runs before
 * `dist/` is built in CI), and the root entry is asserted to expose every
 * runtime value the client entry exposes.  The root entry legitimately carries
 * extra provider/registry/node exports, so only the client -> root direction is
 * pinned; the last test pins the other half — the client entry must not grow
 * provider-side exports.
 *
 * Run with: pnpm --filter @routedock/routedock test
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as root from '../index.js'
import * as client from '../client/index.js'

/** Runtime values published only by the root entry. */
const ROOT_ONLY_EXPORTS = [
  'routedock',
  'registerProvider',
  'reconcileAbandonedSessions',
  'runStartupReconciliation',
  'signManifest',
  'verifyManifestSignature',
  'manifestDigest',
  'SupabaseSeenTxStore',
  'FileSpendStore',
]

/** The client API the READMEs promise from the package root. */
const CLIENT_API_EXPORTS = [
  'RouteDockClient',
  'X402Client',
  'MppChargeClient',
  'MppSessionClient',
  'selectMode',
  'createNulthSigner',
]

function runtimeKeys(mod: Record<string, unknown>): string[] {
  return Object.keys(mod).filter((key) => key !== '__esModule')
}

test('root entry exposes every runtime export of the /client entry', () => {
  const rootKeys = new Set(runtimeKeys(root as unknown as Record<string, unknown>))
  const clientKeys = runtimeKeys(client as unknown as Record<string, unknown>)

  const missing = clientKeys.filter((key) => !rootKeys.has(key))

  assert.deepEqual(
    missing,
    [],
    '@routedock/routedock is missing runtime exports published by @routedock/routedock/client: ' +
      missing.join(', '),
  )
})

test('root entry publishes the documented client API', () => {
  for (const name of CLIENT_API_EXPORTS) {
    const fromRoot = (root as unknown as Record<string, unknown>)[name]
    const fromClient = (client as unknown as Record<string, unknown>)[name]
    assert.equal(
      typeof fromRoot,
      'function',
      `${name} must be a runtime export of the root entry (received ${typeof fromRoot})`,
    )
    assert.equal(fromRoot, fromClient, `${name} must be the same binding in both entries`)
  }
})

test('root entry MppSessionClient is usable, not a type-only re-export', () => {
  const { MppSessionClient } = root as unknown as {
    MppSessionClient: new (...args: never[]) => { openSession: unknown }
  }
  assert.equal(typeof MppSessionClient, 'function')
  assert.equal(typeof MppSessionClient.prototype.openSession, 'function')
})

test('/client entry stays free of provider-side exports', () => {
  const clientKeys = new Set(runtimeKeys(client as unknown as Record<string, unknown>))
  const leaked = ROOT_ONLY_EXPORTS.filter((name) => clientKeys.has(name))
  assert.deepEqual(
    leaked,
    [],
    '@routedock/routedock/client must not publish provider-side exports, found: ' + leaked.join(', '),
  )
})
