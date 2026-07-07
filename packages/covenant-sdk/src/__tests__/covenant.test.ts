/**
 * Covenant SDK unit tests — no chain RPC required.
 */

import assert from 'node:assert/strict'
import {
  CovenantClient,
  CovenantPolicyError,
  commitAllowlist,
  commitDailyCap,
  createCovenantSigner,
  createPolicyState,
  decodeAuthSignature,
  setCovenantPaymentContext,
} from '../index.js'

const COVENANT_ACCOUNT = 'CAX5IDLC2XHGQSEA2YN3LPLZ7EXLMRXYX3HFJGKFXS6B7OQXBKWO44LT'
const PAYEE_A = 'GDHLJWBM6Z2Y4KF6Z4JAFIUUO2KAXAJ6MAIUK2XMGBQ7ZUUZ7HFPW2BK'
const PAYEE_B = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
const WITNESS = 'test-witness-secret'

// ── Policy commitments hide raw values ───────────────────────────────────────

{
  const cap1 = commitDailyCap(1_000_000n, WITNESS)
  const cap2 = commitDailyCap(2_000_000n, WITNESS)
  assert.notEqual(cap1, cap2, 'different caps produce different commitments')
  assert.match(cap1, /^[0-9a-f]{64}$/, 'commitment is hex sha256')

  const list = commitAllowlist([PAYEE_A, PAYEE_B], WITNESS)
  assert.doesNotMatch(list, /GDHL/, 'allowlist commitment must not contain raw payee')
  console.log('✓ commitments hide allowlist and cap')
}

// ── Proof generation and auth signature encoding ─────────────────────────────

{
  const policy = createPolicyState({
    dailyCapUsdc: '1.00',
    allowedPayees: [PAYEE_A],
    witnessSecret: WITNESS,
    ledgerSequence: 50_000,
  })

  const client = new CovenantClient({ covenantAccount: COVENANT_ACCOUNT, policy })
  const proof = client.buildPaymentAuthProof({
    authEntry: Buffer.from('mock-auth-entry').toString('base64'),
    payee: PAYEE_A,
    amountStroops: 10_000n,
    assetContract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    ledgerSequence: 50_000,
  })

  assert.equal(proof.version, 1)
  assert.ok(proof.proof.length > 0)
  assert.equal(proof.publicInputs.allowlistCommitment, policy.allowlistCommitment)
  assert.equal(client.dailySpendStroops, 10_000n)

  const encoded = client.encodeProof(proof)
  const decoded = decodeAuthSignature(encoded)
  assert.equal(decoded.covenant, 'zk-v1')
  console.log('✓ proof generation and encoding')
}

// ── Policy enforcement (off-chain, mirrors __check_auth semantics) ───────────

{
  const policy = createPolicyState({
    dailyCapUsdc: '0.001',
    allowedPayees: [PAYEE_A],
    witnessSecret: WITNESS,
  })
  const client = new CovenantClient({ covenantAccount: COVENANT_ACCOUNT, policy })

  assert.throws(
    () =>
      client.buildPaymentAuthProof({
        authEntry: Buffer.from('x').toString('base64'),
        payee: PAYEE_B,
        amountStroops: 1_000n,
        assetContract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
        ledgerSequence: 100,
      }),
    (err: unknown) => err instanceof CovenantPolicyError && err.code === 'payee_not_allowed',
  )

  assert.throws(
    () =>
      client.buildPaymentAuthProof({
        authEntry: Buffer.from('y').toString('base64'),
        payee: PAYEE_A,
        amountStroops: 2_000_000n,
        assetContract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
        ledgerSequence: 100,
      }),
    (err: unknown) => err instanceof CovenantPolicyError && err.code === 'daily_cap_exceeded',
  )
  console.log('✓ policy enforcement')
}

// ── x402-compatible signer attaches proof as auth signature ───────────────────

{
  const signerConfig = {
    covenantAccount: COVENANT_ACCOUNT,
    policy: createPolicyState({
      dailyCapUsdc: '1.00',
      allowedPayees: [PAYEE_A],
      witnessSecret: WITNESS,
    }),
  }

  setCovenantPaymentContext(signerConfig, {
    payee: PAYEE_A,
    amountStroops: 5_000n,
    assetContract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    ledgerSequence: 200,
  })

  const signer = createCovenantSigner(signerConfig)
  assert.equal(signer.address, COVENANT_ACCOUNT)

  const result = await signer.signAuthEntry(
    Buffer.from('auth-entry-for-x402').toString('base64'),
  )
  assert.equal(result.signerAddress, COVENANT_ACCOUNT)

  const decoded = decodeAuthSignature(result.signedAuthEntry)
  assert.equal(decoded.proof.publicInputs.payeeHash.length, 64)
  console.log('✓ covenant signer attaches ZK proof as auth signature')
}

console.log('\nAll covenant-sdk tests passed.')
