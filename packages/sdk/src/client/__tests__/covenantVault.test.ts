/**
 * Covenant ZK vault integration tests — no live chain or x402 settlement.
 */

import assert from 'node:assert/strict'
import {
  assertCovenantVaultManifest,
  prepareCovenantSigner,
} from '../CovenantZkVault.js'
import type { RouteDockManifest } from '../../types.js'
import { RouteDockManifestError } from '../../errors.js'
import { decodeAuthSignature } from '../CovenantZkVault.js'

const COVENANT = 'CAX5IDLC2XHGQSEA2YN3LPLZ7EXLMRXYX3HFJGKFXS6B7OQXBKWO44LT'
const PAYEE = 'GDHLJWBM6Z2Y4KF6Z4JAFIUUO2KAXAJ6MAIUK2XMGBQ7ZUUZ7HFPW2BK'

const baseManifest: RouteDockManifest = {
  routedock: '1.0',
  name: 'Covenant Test Provider',
  description: 'ZK vault test',
  modes: ['x402'],
  network: 'testnet',
  asset: 'USDC',
  asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
  payee: PAYEE,
  pricing: {
    x402: {
      amount: '0.001',
      per: 'request',
      facilitator: 'https://channels.openzeppelin.com/x402/testnet',
    },
  },
  endpoints: { price: 'GET /price' },
  tags: ['test'],
  vault: 'covenant-zk',
  covenant_account: COVENANT,
}

assertCovenantVaultManifest(baseManifest, COVENANT)

assert.throws(
  () => assertCovenantVaultManifest({ ...baseManifest, vault: 'agent-vault' }, COVENANT),
  RouteDockManifestError,
)

const vault = {
  mode: 'covenant-zk' as const,
  covenantAccount: COVENANT,
  witnessSecret: 'witness',
  allowedPayees: [PAYEE],
  dailyCapUsdc: '1.00',
}

const { signer } = await prepareCovenantSigner(
  vault,
  baseManifest,
  'x402',
  'testnet',
  100_000,
)
assert.equal(signer.address, COVENANT)

const signed = await signer.signAuthEntry(
  Buffer.from('route-dock-auth-entry').toString('base64'),
)
const decoded = decodeAuthSignature(signed.signedAuthEntry)
assert.equal(decoded.proof.version, 1)
assert.doesNotMatch(decoded.proof.publicInputs.payeeHash, new RegExp(PAYEE.slice(4)))
assert.notEqual(decoded.proof.publicInputs.capCommitment, '1.00')
assert.notEqual(decoded.proof.publicInputs.allowlistCommitment, PAYEE)

console.log('✓ Covenant ZK vault SDK integration PASSED')
