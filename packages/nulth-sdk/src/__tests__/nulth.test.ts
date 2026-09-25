/**
 * Nulth SDK unit tests — no chain RPC required.
 */

import assert from 'node:assert/strict'
import { Address, Networks, hash, nativeToScVal, xdr } from '@stellar/stellar-sdk'
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

const NULTH_ACCOUNT = 'CAX5IDLC2XHGQSEA2YN3LPLZ7EXLMRXYX3HFJGKFXS6B7OQXBKWO44LT'
const PAYEE_A = 'GDHLJWBM6Z2Y4KF6Z4JAFIUUO2KAXAJ6MAIUK2XMGBQ7ZUUZ7HFPW2BK'
const PAYEE_B = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
const USDC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const OTHER_ASSET = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
const WITNESS = 'test-witness-secret'

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
    assetContract: USDC,
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
        assetContract: USDC,
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
        assetContract: USDC,
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
    assetContract: USDC,
    ledgerSequence: 200,
  })

  const signer = createNulthSigner(signerConfig)
  assert.equal(signer.address, NULTH_ACCOUNT)

  const result = await signer.signAuthEntry(
    transferPreimage(USDC, NULTH_ACCOUNT, PAYEE_A, 5_000n),
  )
  assert.equal(result.signerAddress, NULTH_ACCOUNT)

  const decoded = decodeAuthSignature(result.signedAuthEntry)
  assert.equal(decoded.proof.publicInputs.payeeHash.length, 64)
  assert.equal(decoded.proof.publicInputs.amountStroops, '5000')
  console.log('✓ nulth signer attaches ZK proof as auth signature')
}

// ── signAuthEntry rejects an auth entry that doesn't match the payment context ─

{
  function makeSigner(amountStroops = 5_000n) {
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
      amountStroops,
      assetContract: USDC,
      ledgerSequence: 200,
    })
    return createNulthSigner(signerConfig)
  }

  const isMismatch = (err: unknown) =>
    err instanceof NulthPolicyError && err.code === 'auth_entry_mismatch'

  // wrong `to` (payee)
  await assert.rejects(
    () => makeSigner().signAuthEntry(transferPreimage(USDC, NULTH_ACCOUNT, PAYEE_B, 5_000n)),
    isMismatch,
    'rejects when the preimage payee differs from paymentContext.payee',
  )

  // wrong amount, higher
  await assert.rejects(
    () => makeSigner().signAuthEntry(transferPreimage(USDC, NULTH_ACCOUNT, PAYEE_A, 10_000_000_000n)),
    isMismatch,
    'rejects when the amount is higher than paymentContext.amountStroops',
  )

  // wrong amount, lower
  await assert.rejects(
    () => makeSigner().signAuthEntry(transferPreimage(USDC, NULTH_ACCOUNT, PAYEE_A, 1n)),
    isMismatch,
    'rejects when the amount is lower than paymentContext.amountStroops',
  )

  // wrong contract
  await assert.rejects(
    () => makeSigner().signAuthEntry(transferPreimage(OTHER_ASSET, NULTH_ACCOUNT, PAYEE_A, 5_000n)),
    isMismatch,
    'rejects when the invoked contract differs from paymentContext.assetContract',
  )

  // wrong `from`
  await assert.rejects(
    () => makeSigner().signAuthEntry(transferPreimage(USDC, PAYEE_B, PAYEE_A, 5_000n)),
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
            nativeToScVal(NULTH_ACCOUNT, { type: 'address' }),
            nativeToScVal(PAYEE_A, { type: 'address' }),
            nativeToScVal(5_000n, { type: 'i128' }),
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
      () => makeSigner().signAuthEntry(preimage),
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
            nativeToScVal(NULTH_ACCOUNT, { type: 'address' }),
            nativeToScVal(PAYEE_A, { type: 'address' }),
            nativeToScVal(5_000n, { type: 'i128' }),
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
            nativeToScVal(NULTH_ACCOUNT, { type: 'address' }),
            nativeToScVal(PAYEE_A, { type: 'address' }),
            nativeToScVal(5_000n, { type: 'i128' }),
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
      () => makeSigner().signAuthEntry(preimage),
      isMismatch,
      'rejects when the invocation has sub-invocations',
    )
  }

  // not a HashIdPreimage / envelopeTypeSorobanAuthorization at all
  await assert.rejects(
    () => makeSigner().signAuthEntry(Buffer.from('auth-entry-for-x402').toString('base64')),
    isMismatch,
    'rejects a plain non-XDR string',
  )

  console.log('✓ signAuthEntry rejects auth entries that mismatch the payment context')
}

// ── A rejected entry never advances daily spend ──────────────────────────────

{
  const signerConfig = {
    nulthAccount: NULTH_ACCOUNT,
    network: 'testnet' as const,
    policy: createPolicyState({
      dailyCapUsdc: '0.0005',
      allowedPayees: [PAYEE_A],
      witnessSecret: WITNESS,
    }),
  }
  setNulthPaymentContext(signerConfig, {
    payee: PAYEE_A,
    amountStroops: 5_000n,
    assetContract: USDC,
    ledgerSequence: 200,
  })
  const signer = createNulthSigner(signerConfig)

  await assert.rejects(
    () => signer.signAuthEntry(transferPreimage(USDC, NULTH_ACCOUNT, PAYEE_B, 5_000n)),
    (err: unknown) => err instanceof NulthPolicyError && err.code === 'auth_entry_mismatch',
  )

  // Cap equals the context amount — a mismatched attempt must not have spent it.
  const result = await signer.signAuthEntry(transferPreimage(USDC, NULTH_ACCOUNT, PAYEE_A, 5_000n))
  const decoded = decodeAuthSignature(result.signedAuthEntry)
  assert.equal(decoded.proof.publicInputs.amountStroops, '5000')
  console.log('✓ a rejected sign attempt leaves daily spend unchanged')
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
