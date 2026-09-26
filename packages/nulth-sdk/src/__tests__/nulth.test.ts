/**
 * Nulth SDK unit tests — no chain RPC required.
 */

import assert from 'node:assert/strict'
import {
  NulthClient,
  NulthPolicyError,
  commitAllowlist,
  commitDailyCap,
  createNulthSigner,
  createPolicyState,
  decodeAuthSignature,
  setNulthPaymentContext,
} from '../index.js'
import type { NulthClientConfig } from '../index.js'

const NULTH_ACCOUNT = 'CAX5IDLC2XHGQSEA2YN3LPLZ7EXLMRXYX3HFJGKFXS6B7OQXBKWO44LT'
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

// ── Canonical USDC → stroops converter ──────────────────────────────────────

{
  const { usdcToStroops } = await import('../usdc.js')
  assert.equal(usdcToStroops('1.00'), 10_000_000n)
  assert.equal(usdcToStroops('0.0001'), 1_000n)
  assert.equal(usdcToStroops('0'), 0n)
  assert.throws(() => usdcToStroops('-1'), RangeError)
  assert.throws(() => usdcToStroops('0.00000001'), RangeError)
  assert.throws(() => usdcToStroops(''), RangeError)
  assert.throws(() => usdcToStroops('1e-7'), RangeError)
  console.log('✓ usdcToStroops canonical converter validates')
}

// ── Proof generation and auth signature encoding ─────────────────────────────

{
  const policy = createPolicyState({
    dailyCapUsdc: '1.00',
    allowedPayees: [PAYEE_A],
    witnessSecret: WITNESS,
    ledgerSequence: 50_000,
  })

  const client = new NulthClient({ nulthAccount: NULTH_ACCOUNT, network: 'testnet', policy })
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
  assert.equal(decoded.nulth, 'zk-v1')
  console.log('✓ proof generation and encoding')
}

// ── Policy enforcement (off-chain, mirrors __check_auth semantics) ───────────

{
  const policy = createPolicyState({
    dailyCapUsdc: '0.001',
    allowedPayees: [PAYEE_A],
    witnessSecret: WITNESS,
  })
  const client = new NulthClient({ nulthAccount: NULTH_ACCOUNT, network: 'testnet', policy })

  assert.throws(
    () =>
      client.buildPaymentAuthProof({
        authEntry: Buffer.from('x').toString('base64'),
        payee: PAYEE_B,
        amountStroops: 1_000n,
        assetContract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
        ledgerSequence: 100,
      }),
    (err: unknown) => err instanceof NulthPolicyError && err.code === 'payee_not_allowed',
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
    (err: unknown) => err instanceof NulthPolicyError && err.code === 'daily_cap_exceeded',
  )
  console.log('✓ policy enforcement')
}

// ── x402-compatible signer attaches proof as auth signature ───────────────────

{
  const signerConfig = {
    nulthAccount: NULTH_ACCOUNT,
    network: 'testnet' as const,
    policy: createPolicyState({
      dailyCapUsdc: '1.00',
      allowedPayees: [PAYEE_A],
      witnessSecret: WITNESS,
    }),
  }

  setNulthPaymentContext(signerConfig, {
    payee: PAYEE_A,
    amountStroops: 5_000n,
    assetContract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    ledgerSequence: 200,
  })

  const signer = createNulthSigner(signerConfig)
  assert.equal(signer.address, NULTH_ACCOUNT)

  const result = await signer.signAuthEntry(
    Buffer.from('auth-entry-for-x402').toString('base64'),
  )
  assert.equal(result.signerAddress, NULTH_ACCOUNT)

  const decoded = decodeAuthSignature(result.signedAuthEntry)
  assert.equal(decoded.proof.publicInputs.payeeHash.length, 64)
  console.log('✓ nulth signer attaches ZK proof as auth signature')
}

console.log('\nAll nulth-sdk tests passed.')

assert.throws(
  () =>
    new NulthClient({
      nulthAccount: NULTH_ACCOUNT,
      network: 'mainnet',
      policy: createPolicyState({
        dailyCapUsdc: '1.00',
        allowedPayees: [PAYEE_A],
        witnessSecret: WITNESS,
      }),
    }),
  /insecure mock prover on mainnet/,
)
console.log('✓ mainnet rejects the insecure mock prover at construction')

{
  const client = new NulthClient({
    nulthAccount: NULTH_ACCOUNT,
    network: 'testnet',
    prover: 'mock',
    policy: createPolicyState({
      dailyCapUsdc: '1.00',
      allowedPayees: [PAYEE_A],
      witnessSecret: WITNESS,
    }),
  })
  assert.equal(client.proverBackend, 'mock')
  console.log('✓ NulthClient stores prover backend')
}

// ── Mainnet guard fails closed for missing/misspelled networks and provers ────

{
  const policy = createPolicyState({
    dailyCapUsdc: '1.00',
    allowedPayees: [PAYEE_A],
    witnessSecret: WITNESS,
  })

  const cases: Array<{ name: string; config: Record<string, unknown>; match: RegExp }> = [
    {
      name: 'network omitted',
      config: { nulthAccount: NULTH_ACCOUNT, policy },
      match: /network must be 'testnet', got undefined/,
    },
    {
      name: "network 'pubnet'",
      config: { nulthAccount: NULTH_ACCOUNT, network: 'pubnet', policy },
      match: /network must be 'testnet', got pubnet/,
    },
    {
      name: "network 'public'",
      config: { nulthAccount: NULTH_ACCOUNT, network: 'public', policy },
      match: /network must be 'testnet', got public/,
    },
    {
      name: "network 'Mainnet'",
      config: { nulthAccount: NULTH_ACCOUNT, network: 'Mainnet', policy },
      match: /network must be 'testnet', got Mainnet/,
    },
    {
      name: "mainnet with prover 'wasm'",
      config: { nulthAccount: NULTH_ACCOUNT, network: 'mainnet', prover: 'wasm', policy },
      match: /unknown prover backend/,
    },
    {
      name: "testnet with prover 'wasm'",
      config: { nulthAccount: NULTH_ACCOUNT, network: 'testnet', prover: 'wasm', policy },
      match: /unknown prover backend/,
    },
  ]

  for (const { name, config, match } of cases) {
    assert.throws(
      () => new NulthClient(config as unknown as NulthClientConfig),
      match,
      `${name} must fail closed`,
    )
  }
  console.log('✓ mainnet guard fails closed for missing/misspelled network and prover values')
}

