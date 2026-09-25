/**
 * Nulth ZK vault integration tests — no live chain or x402 settlement.
 */

import assert from 'node:assert/strict'
import { Address, Networks, hash, nativeToScVal, xdr } from '@stellar/stellar-sdk'
import {
  assertNulthVaultManifest,
  prepareNulthSigner,
} from '../NulthVault.js'
import type { RouteDockManifest } from '../../types.js'
import { RouteDockManifestError } from '../../errors.js'
import { decodeAuthSignature, NulthPolicyError } from '../NulthVault.js'

const NULTH = 'CAX5IDLC2XHGQSEA2YN3LPLZ7EXLMRXYX3HFJGKFXS6B7OQXBKWO44LT'
const PAYEE = 'GDHLJWBM6Z2Y4KF6Z4JAFIUUO2KAXAJ6MAIUK2XMGBQ7ZUUZ7HFPW2BK'
const OTHER_PAYEE = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
const USDC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const OTHER_ASSET = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'

/** Build a real Soroban authorization preimage for a SEP-41 `transfer` call. */
function transferPreimage(asset: string, from: string, to: string, amount: bigint): string {
  const invocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(asset).toScAddress(),
        functionName: 'transfer',
        args: [
          nativeToScVal(from, { type: 'address' }),
          nativeToScVal(to, { type: 'address' }),
          nativeToScVal(amount, { type: 'i128' }),
        ],
      }),
    ),
    subInvocations: [],
  })
  return xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: hash(Buffer.from(Networks.TESTNET)),
      nonce: xdr.Int64.fromString('1'),
      signatureExpirationLedger: 300,
      invocation,
    }),
  ).toXDR('base64')
}

const baseManifest: RouteDockManifest = {
  routedock: '1.0',
  name: 'Nulth Test Provider',
  description: 'ZK vault test',
  modes: ['x402'],
  network: 'testnet',
  asset: 'USDC',
  asset_contract: USDC,
  payee: PAYEE,
  pricing: {
    x402: {
      amount: '0.001',
      per: 'request',
      facilitator: 'https://channels.openzeppelin.com/x402/testnet',
    },
  },
  endpoints: { price: { method: 'GET', path: '/price' } },
  tags: ['test'],
  vault: 'nulth',
  nulth_account: NULTH,
}

assertNulthVaultManifest(baseManifest, NULTH)

assert.throws(
  () => assertNulthVaultManifest({ ...baseManifest, vault: 'agent-vault' }, NULTH),
  RouteDockManifestError,
)

const vault = {
  mode: 'nulth' as const,
  nulthAccount: NULTH,
  witnessSecret: 'witness',
  allowedPayees: [PAYEE],
  dailyCapUsdc: '1.00',
}

const { signer } = await prepareNulthSigner(
  vault,
  baseManifest,
  'x402',
  'testnet',
  100_000,
)
assert.equal(signer.address, NULTH)

// 0.001 USDC == 10_000 stroops, matching baseManifest.pricing.x402.amount
const signed = await signer.signAuthEntry(
  transferPreimage(USDC, NULTH, PAYEE, 10_000n),
)
const decoded = decodeAuthSignature(signed.signedAuthEntry)
assert.equal(decoded.proof.version, 1)
assert.doesNotMatch(decoded.proof.publicInputs.payeeHash, new RegExp(PAYEE.slice(4)))
assert.notEqual(decoded.proof.publicInputs.capCommitment, '1.00')
assert.notEqual(decoded.proof.publicInputs.allowlistCommitment, PAYEE)

console.log('✓ Nulth ZK vault SDK integration PASSED')

{
  const vault = {
    mode: 'nulth' as const,
    nulthAccount: NULTH,
    witnessSecret: 'witness',
    allowedPayees: [PAYEE],
    dailyCapUsdc: '1.00',
  }

  const manifest: RouteDockManifest = { ...baseManifest, network: 'mainnet' }

  await assert.rejects(
    () => prepareNulthSigner(vault, manifest, 'x402', 'mainnet', 100_000),
    (err: unknown) =>
      err instanceof RouteDockManifestError &&
      /mock prover/i.test(err.message),
  )
  console.log('✓ mainnet guard rejects mock prover')
}

// ── signAuthEntry rejects an auth entry that doesn't match the payment context ─

{
  const isMismatch = (err: unknown) =>
    err instanceof NulthPolicyError && err.code === 'auth_entry_mismatch'

  async function freshSigner() {
    const { signer } = await prepareNulthSigner(vault, baseManifest, 'x402', 'testnet', 100_000)
    return signer
  }

  // wrong `to` (payee)
  await assert.rejects(
    () => freshSigner().then((s) => s.signAuthEntry(transferPreimage(USDC, NULTH, OTHER_PAYEE, 10_000n))),
    isMismatch,
    'rejects when the preimage payee differs from paymentContext.payee',
  )

  // wrong amount, higher
  await assert.rejects(
    () => freshSigner().then((s) => s.signAuthEntry(transferPreimage(USDC, NULTH, PAYEE, 10_000_000_000n))),
    isMismatch,
    'rejects when the amount is higher than paymentContext.amountStroops',
  )

  // wrong amount, lower
  await assert.rejects(
    () => freshSigner().then((s) => s.signAuthEntry(transferPreimage(USDC, NULTH, PAYEE, 1n))),
    isMismatch,
    'rejects when the amount is lower than paymentContext.amountStroops',
  )

  // wrong contract
  await assert.rejects(
    () => freshSigner().then((s) => s.signAuthEntry(transferPreimage(OTHER_ASSET, NULTH, PAYEE, 10_000n))),
    isMismatch,
    'rejects when the invoked contract differs from paymentContext.assetContract',
  )

  // wrong `from`
  await assert.rejects(
    () => freshSigner().then((s) => s.signAuthEntry(transferPreimage(USDC, OTHER_PAYEE, PAYEE, 10_000n))),
    isMismatch,
    'rejects when the from argument differs from nulthAccount',
  )

  // wrong function name
  {
    const invocation = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(USDC).toScAddress(),
          functionName: 'approve',
          args: [
            nativeToScVal(NULTH, { type: 'address' }),
            nativeToScVal(PAYEE, { type: 'address' }),
            nativeToScVal(10_000n, { type: 'i128' }),
          ],
        }),
      ),
      subInvocations: [],
    })
    const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
      new xdr.HashIdPreimageSorobanAuthorization({
        networkId: hash(Buffer.from(Networks.TESTNET)),
        nonce: xdr.Int64.fromString('1'),
        signatureExpirationLedger: 300,
        invocation,
      }),
    ).toXDR('base64')

    await assert.rejects(
      () => freshSigner().then((s) => s.signAuthEntry(preimage)),
      isMismatch,
      'rejects when the function name is not transfer',
    )
  }

  // sub-invocations present
  {
    const subInvocation = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(USDC).toScAddress(),
          functionName: 'transfer',
          args: [
            nativeToScVal(NULTH, { type: 'address' }),
            nativeToScVal(PAYEE, { type: 'address' }),
            nativeToScVal(10_000n, { type: 'i128' }),
          ],
        }),
      ),
      subInvocations: [],
    })
    const invocation = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(USDC).toScAddress(),
          functionName: 'transfer',
          args: [
            nativeToScVal(NULTH, { type: 'address' }),
            nativeToScVal(PAYEE, { type: 'address' }),
            nativeToScVal(10_000n, { type: 'i128' }),
          ],
        }),
      ),
      subInvocations: [subInvocation],
    })
    const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
      new xdr.HashIdPreimageSorobanAuthorization({
        networkId: hash(Buffer.from(Networks.TESTNET)),
        nonce: xdr.Int64.fromString('1'),
        signatureExpirationLedger: 300,
        invocation,
      }),
    ).toXDR('base64')

    await assert.rejects(
      () => freshSigner().then((s) => s.signAuthEntry(preimage)),
      isMismatch,
      'rejects when the invocation has sub-invocations',
    )
  }

  // not a HashIdPreimage / envelopeTypeSorobanAuthorization at all
  await assert.rejects(
    () => freshSigner().then((s) => s.signAuthEntry(Buffer.from('route-dock-auth-entry').toString('base64'))),
    isMismatch,
    'rejects a plain non-XDR string',
  )

  console.log('✓ signAuthEntry rejects auth entries that mismatch the payment context')
}

// ── A rejected entry never advances daily spend ──────────────────────────────

{
  const tightVault = {
    mode: 'nulth' as const,
    nulthAccount: NULTH,
    witnessSecret: 'witness',
    allowedPayees: [PAYEE],
    dailyCapUsdc: '0.001',
  }
  const { signer } = await prepareNulthSigner(tightVault, baseManifest, 'x402', 'testnet', 100_000)

  await assert.rejects(
    () => signer.signAuthEntry(transferPreimage(USDC, NULTH, OTHER_PAYEE, 10_000n)),
    (err: unknown) => err instanceof NulthPolicyError && err.code === 'auth_entry_mismatch',
  )

  // Cap equals the context amount (0.001 USDC == 10_000 stroops) — the
  // mismatched attempt above must not have spent it.
  const result = await signer.signAuthEntry(transferPreimage(USDC, NULTH, PAYEE, 10_000n))
  const decoded = decodeAuthSignature(result.signedAuthEntry)
  assert.equal(decoded.proof.publicInputs.amountStroops, '10000')
  console.log('✓ a rejected sign attempt leaves daily spend unchanged')
}
