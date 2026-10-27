/**
 * Nulth signature encoding + authorizeEntry tests — no chain RPC required (#552).
 */

import assert from 'node:assert/strict'
import {
  Address,
  Keypair,
  Networks,
  authorizeEntry,
  hash,
  nativeToScVal,
  scValToNative,
  StrKey,
  xdr,
} from '@stellar/stellar-sdk'
import type { SignAuthEntry } from '@stellar/stellar-sdk/contract'
import {
  NULTH_SIGNATURE_VERSION,
  NULTH_SIGNER_MARKER,
  authDigestFromEntry,
  commitDailyCap,
  createNulthSigner,
  createPolicyState,
  dayBucket,
  decodeNulthProofScVal,
  hashPayee,
  isNulthStellarSigner,
  nulthAuthorizeEntry,
  nulthProofScVal,
  setNulthPaymentContext,
  type NulthProof,
  type NulthSignerConfig,
} from '../index.js'

const NULTH_ACCOUNT = 'CAX5IDLC2XHGQSEA2YN3LPLZ7EXLMRXYX3HFJGKFXS6B7OQXBKWO44LT'
const PAYEE = 'GDHLJWBM6Z2Y4KF6Z4JAFIUUO2KAXAJ6MAIUK2XMGBQ7ZUUZ7HFPW2BK'
const USDC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const WITNESS = 'test-witness-secret'
const DAILY_CAP_STROOPS = 10_000_000n
const AMOUNT = 10_000n
const LEDGER = 50_000
const EXPIRATION = 51_000

function transferInvocation(
  from: string,
  to: string,
  amount: bigint,
): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: Address.fromString(USDC).toScAddress(),
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
}

/** An auth entry as Soroban RPC returns it: address credential, void signature. */
function unsignedEntry(payer: string): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(payer).toScAddress(),
        nonce: xdr.Int64.fromString('7'),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: transferInvocation(payer, PAYEE, AMOUNT),
  })
}

/**
 * The callback stellar-sdk's `signAuthEntries` builds internally: it hands
 * `authorizeEntry` a preimage-to-bytes function that routes through the signer's
 * `signAuthEntry`.
 */
function sdkCallback(
  signAuthEntry: SignAuthEntry,
  address: string,
  seen: xdr.HashIdPreimage[],
) {
  return async (preimage: xdr.HashIdPreimage): Promise<Buffer> => {
    seen.push(preimage)
    const { signedAuthEntry } = await signAuthEntry(preimage.toXDR('base64'), { address })
    return Buffer.from(signedAuthEntry, 'base64')
  }
}

function nulthSigner(): NulthSignerConfig {
  const config: NulthSignerConfig = {
    nulthAccount: NULTH_ACCOUNT,
    network: 'testnet',
    prover: 'mock',
    policy: createPolicyState({
      dailyCapUsdc: '1.00',
      allowedPayees: [PAYEE],
      witnessSecret: WITNESS,
      ledgerSequence: LEDGER,
    }),
  }
  setNulthPaymentContext(config, {
    payee: PAYEE,
    amountStroops: AMOUNT,
    assetContract: USDC,
    ledgerSequence: LEDGER,
  })
  return config
}

// ── The proof reaches SorobanAddressCredentials.signature ───────────────────

{
  const config = nulthSigner()
  const signer = createNulthSigner(config)
  const seen: xdr.HashIdPreimage[] = []

  const signed = await nulthAuthorizeEntry(
    unsignedEntry(NULTH_ACCOUNT),
    sdkCallback(signer.signAuthEntry, NULTH_ACCOUNT, seen),
    EXPIRATION,
    Networks.TESTNET,
  )

  assert.equal(seen.length, 1, 'the signer is asked for exactly one signature')
  const credentials = signed.credentials().address()
  assert.equal(credentials.signatureExpirationLedger(), EXPIRATION, 'expiry is set')
  assert.equal(
    credentials.address().toXDR('base64'),
    Address.fromString(NULTH_ACCOUNT).toScAddress().toXDR('base64'),
    'credential address is the Nulth account',
  )
  assert.equal(
    signed.rootInvocation().toXDR('base64'),
    unsignedEntry(NULTH_ACCOUNT).rootInvocation().toXDR('base64'),
    'the authorised invocation is untouched',
  )

  // The preimage must be the one the network recomputes, or the proof binds
  // something else entirely.
  const expected = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: hash(Buffer.from(Networks.TESTNET)),
      nonce: xdr.Int64.fromString('7'),
      signatureExpirationLedger: EXPIRATION,
      invocation: unsignedEntry(NULTH_ACCOUNT).rootInvocation(),
    }),
  )
  assert.equal(seen[0]!.toXDR('base64'), expected.toXDR('base64'), 'preimage matches stellar-base')

  const proof = decodeNulthProofScVal(credentials.signature())
  assert.equal(proof.nulth, NULTH_SIGNATURE_VERSION)
  assert.equal(proof.proof.version, 1)
  assert.ok(proof.proof.proof.length > 0, 'proof bytes are present')
  const inputs = proof.proof.publicInputs
  assert.equal(inputs.authDigest, authDigestFromEntry(seen[0]!.toXDR('base64')))
  assert.equal(inputs.amountStroops, AMOUNT.toString())
  assert.equal(inputs.dayBucket, dayBucket(LEDGER).toString())
  assert.equal(inputs.payeeHash, hashPayee(PAYEE))
  assert.equal(inputs.allowlistCommitment, config.policy.allowlistCommitment)
  assert.equal(inputs.capCommitment, commitDailyCap(DAILY_CAP_STROOPS, WITNESS))
  console.log('✓ nulthAuthorizeEntry writes the Nulth proof into a C... credential')
}

// ── The credential is a contract-readable vec[map] ──────────────────────────

{
  const config = nulthSigner()
  const signer = createNulthSigner(config)
  const signed = await nulthAuthorizeEntry(
    unsignedEntry(NULTH_ACCOUNT),
    sdkCallback(signer.signAuthEntry, NULTH_ACCOUNT, []),
    EXPIRATION,
    Networks.TESTNET,
  )
  const signature = signed.credentials().address().signature()
  assert.equal(signature.switch(), xdr.ScValType.scvVec(), 'signature is a vec, like Stellar account sigs')
  const entries = signature.vec()
  assert.equal(entries?.length, 1, 'exactly one signature map')
  const fields = Object.keys(scValToNative(entries[0]!) as Record<string, unknown>).sort()
  assert.deepEqual(fields, [
    'allowlist_commitment',
    'amount_stroops',
    'auth_digest',
    'cap_commitment',
    'day_bucket',
    'nulth',
    'payee_hash',
    'proof',
    'version',
  ])
  console.log('✓ the signature ScVal is the vec[map] a __check_auth reads')
}

// ── #356: the stock ed25519 authorizeEntry cannot sign a C... payer ──────────

{
  const keypair = Keypair.random()
  // The callback shape @x402/stellar's ExactStellarScheme ends up with: bytes of
  // a signature, no publicKey. stellar-base then reads the credential address as
  // an ed25519 key, which a contract account is not.
  const sep43Callback = async (preimage: xdr.HashIdPreimage): Promise<Buffer> =>
    Buffer.from(keypair.sign(hash(preimage.toXDR())))

  await assert.rejects(
    () => authorizeEntry(unsignedEntry(NULTH_ACCOUNT), sep43Callback, EXPIRATION, Networks.TESTNET),
    /invalid version byte/,
    'the default authorizeEntry still fails on the Nulth account',
  )
  console.log('✓ stellar-base authorizeEntry still rejects a contract account (#356)')
}

// ── The ed25519 path is unchanged for G... signers ───────────────────────────

{
  const keypair = Keypair.random()
  const entry = unsignedEntry(keypair.publicKey())
  const payload = (preimage: xdr.HashIdPreimage) => hash(preimage.toXDR())
  const signed = await authorizeEntry(
    entry,
    async (preimage) => Buffer.from(keypair.sign(payload(preimage))),
    EXPIRATION,
    Networks.TESTNET,
  )
  const signature = signed.credentials().address().signature()
  const first = (
    scValToNative(signature) as Array<{
      public_key: Uint8Array
      signature: Buffer
    }>
  )[0]
  assert.ok(first, 'the ed25519 signature vec holds an entry')
  assert.equal(
    StrKey.encodeEd25519PublicKey(Buffer.from(first.public_key)),
    keypair.publicKey(),
    'ed25519 signature keeps public_key',
  )

  const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: hash(Buffer.from(Networks.TESTNET)),
      nonce: xdr.Int64.fromString('7'),
      signatureExpirationLedger: EXPIRATION,
      invocation: entry.rootInvocation(),
    }),
  )
  assert.ok(
    keypair.verify(payload(preimage), first.signature),
    'the ed25519 signature still binds the authorization preimage',
  )

  await assert.rejects(
    () => nulthAuthorizeEntry(entry, async () => Buffer.from('x'), EXPIRATION, Networks.TESTNET),
    /contract accounts \(C\.\.\.\) only/,
    'the Nulth scheme refuses a classic account instead of mis-signing it',
  )
  console.log('✓ ed25519 G... signing is untouched and the Nulth scheme declines it')
}

// ── Signer identity marker ───────────────────────────────────────────────────

{
  const signer = createNulthSigner(nulthSigner())
  assert.ok(isNulthStellarSigner(signer), 'a Nulth signer is recognised')
  assert.equal(signer[NULTH_SIGNER_MARKER], NULTH_SIGNATURE_VERSION)
  assert.ok(
    !isNulthStellarSigner({
      address: Keypair.random().publicKey(),
      signAuthEntry: async () => ({ signedAuthEntry: '' }),
    }),
    'an ed25519 signer is not',
  )
  console.log('✓ the marker separates Nulth payers from ed25519 payers')
}

// ── Codec rejections ─────────────────────────────────────────────────────────

{
  assert.throws(() => decodeNulthProofScVal(xdr.ScVal.scvU32(1)), /not a vec/)
  assert.throws(() => decodeNulthProofScVal(xdr.ScVal.scvVec([])), /exactly one map/)
  assert.throws(
    () => nulthProofScVal({ nulth: 'zk-v2' as never, proof: proofFixture() }),
    /unsupported Nulth signature format/,
  )

  const roundTripped = decodeNulthProofScVal(nulthProofScVal({ nulth: 'zk-v1', proof: proofFixture() }))
  assert.deepEqual(roundTripped.proof, proofFixture(), 'the codec round-trips')
  console.log('✓ the codec rejects shapes a contract could not read')
}

function proofFixture(): NulthProof {
  return {
    version: 1,
    proof: Buffer.from('proof-bytes').toString('base64'),
    publicInputs: {
      authDigest: 'aa'.repeat(32),
      allowlistCommitment: 'bb'.repeat(32),
      capCommitment: 'cc'.repeat(32),
      payeeHash: 'dd'.repeat(32),
      amountStroops: AMOUNT.toString(),
      dayBucket: dayBucket(LEDGER).toString(),
    },
  }
}

console.log('\nAll nulth-sdk scheme tests passed.')
