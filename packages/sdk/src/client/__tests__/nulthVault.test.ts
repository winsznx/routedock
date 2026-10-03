/**
 * Nulth ZK vault integration tests — no live chain or x402 settlement.
 */

import assert from 'node:assert/strict'
import { Address, Networks, hash, nativeToScVal, xdr } from '@stellar/stellar-sdk'
import { authorizeEntry } from '@stellar/stellar-sdk'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Keypair } from '@stellar/stellar-sdk'
import {
  assertNulthVaultManifest,
  prepareNulthSigner,
  createPolicyState,
  paymentContextFromManifest,
  NulthPolicyError,
  decodeAuthSignature,
} from '../NulthVault.js'
import type { RouteDockManifest } from '../../types.js'
import { RouteDockManifestError, RouteDockSignatureError } from '../../errors.js'
import { resolvePayee } from '../../provider/payee.js'
import { RouteDockClient } from '../RouteDockClient.js'
import { signManifest } from '../../manifest/sign.js'

const NULTH = 'CAX5IDLC2XHGQSEA2YN3LPLZ7EXLMRXYX3HFJGKFXS6B7OQXBKWO44LT'
const PAYEE = 'GDHLJWBM6Z2Y4KF6Z4JAFIUUO2KAXAJ6MAIUK2XMGBQ7ZUUZ7HFPW2BK'
const PAYEE_B = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
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

{
  const vault = {
    mode: 'nulth' as const,
    nulthAccount: NULTH,
    witnessSecret: 'witness',
    allowedPayees: [PAYEE],
    dailyCapUsdc: '1.00',
  }

  for (const network of [undefined, 'pubnet'] as const) {
    await assert.rejects(
      () =>
        prepareNulthSigner(
          vault,
          baseManifest,
          'x402',
          network as unknown as 'testnet' | 'mainnet',
          100_000,
        ),
      (err: unknown) =>
        err instanceof RouteDockManifestError &&
        /network must be 'testnet'/.test(err.message),
      `prepareNulthSigner must reject network=${String(network)}`,
    )
  }
  console.log('✓ prepareNulthSigner fails closed for missing/misspelled network')
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
    () => freshSigner().then((s) => s.signAuthEntry(transferPreimage(USDC, NULTH, PAYEE_B, 10_000n))),
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
    () => freshSigner().then((s) => s.signAuthEntry(transferPreimage(USDC, PAYEE_B, PAYEE, 10_000n))),
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
    () => signer.signAuthEntry(transferPreimage(USDC, NULTH, PAYEE_B, 10_000n)),
    (err: unknown) => err instanceof NulthPolicyError && err.code === 'auth_entry_mismatch',
  )

  // Cap equals the context amount (0.001 USDC == 10_000 stroops) — the
  // mismatched attempt above must not have spent it.
  const result = await signer.signAuthEntry(transferPreimage(USDC, NULTH, PAYEE, 10_000n))
  const decoded = decodeAuthSignature(result.signedAuthEntry)
  assert.equal(decoded.proof.publicInputs.amountStroops, '10000')
  console.log('✓ a rejected sign attempt leaves daily spend unchanged')
}

// --- usdcToStroops validation tests ---

function manifestWithPrice(amount: string): RouteDockManifest {
  const pricing = { ...baseManifest.pricing! }
  pricing.x402 = { ...baseManifest.pricing!.x402!, amount }
  return { ...baseManifest, pricing }
}

const INVALID_AMOUNTS = ['-5', '-1.5', '', '1.123456789', '0.00000009']

for (const amount of INVALID_AMOUNTS) {
  assert.throws(
    () => createPolicyState({ dailyCapUsdc: amount, allowedPayees: [PAYEE], witnessSecret: 'witness' }),
    RangeError,
  )
  assert.throws(
    () => paymentContextFromManifest(
      { payee: PAYEE, asset_contract: baseManifest.asset_contract, pricing: { x402: { amount } } },
      'x402',
      100_000,
    ),
    RangeError,
  )
}
console.log('✓ invalid amounts throw RangeError')

{
  const policy = createPolicyState({ dailyCapUsdc: '1.00', allowedPayees: [PAYEE], witnessSecret: 'witness' })
  assert.equal(policy.dailyCapStroops, 10_000_000n)
}
{
  const ctx = paymentContextFromManifest(
    { payee: PAYEE, asset_contract: baseManifest.asset_contract, pricing: { x402: { amount: '0.001' } } },
    'x402',
    100_000,
  )
  assert.equal(ctx.amountStroops, 10_000n)
}
console.log('✓ valid amounts produce correct stroops')

await assert.rejects(
  () => prepareNulthSigner(vault, manifestWithPrice('-1'), 'x402', 'testnet', 100_000),
  RangeError,
)
console.log('✓ prepareNulthSigner rejects negative price')

// --- per-mode payee override tests ---

{
  const manifestWithOverride: RouteDockManifest = {
    ...baseManifest,
    payee: PAYEE,
    pricing: {
      ...baseManifest.pricing!,
      x402: { ...baseManifest.pricing!.x402!, payee: PAYEE_B },
      'mpp-charge': { amount: '0.001', per: 'request', facilitator: 'https://channels.openzeppelin.com/x402/testnet', payee: PAYEE_B },
    },
  }

  // allowlisting the override address signs (with correct preimage for PAYEE_B)
  {
    const vaultWithOverride = { ...vault, allowedPayees: [PAYEE_B] }
    const { signer } = await prepareNulthSigner(vaultWithOverride, manifestWithOverride, 'x402', 'testnet', 100_000)
    await signer.signAuthEntry(transferPreimage(USDC, NULTH, PAYEE_B, 10_000n))
    console.log('✓ allowlisting override address signs')
  }

  // allowlisting only the top-level payee rejects (preimage targets override payee but vault doesn't allow it)
  {
    const vaultDefault = { ...vault, allowedPayees: [PAYEE] }
    const { signer } = await prepareNulthSigner(vaultDefault, manifestWithOverride, 'x402', 'testnet', 100_000)
    await assert.rejects(
      () => signer.signAuthEntry(transferPreimage(USDC, NULTH, PAYEE_B, 10_000n)),
      (err: unknown) => err instanceof NulthPolicyError && (err as NulthPolicyError).code === 'payee_not_allowed',
    )
    console.log('✓ allowlisting only top-level payee rejects')
  }

  // paymentContextFromManifest returns override when set
  {
    const ctx = paymentContextFromManifest(manifestWithOverride, 'x402', 100_000)
    assert.equal(ctx.payee, resolvePayee(manifestWithOverride, 'x402'))
  }
  {
    const ctx = paymentContextFromManifest(manifestWithOverride, 'mpp-charge', 100_000)
    assert.equal(ctx.payee, resolvePayee(manifestWithOverride, 'mpp-charge'))
  }

  // paymentContextFromManifest returns top-level payee when no override
  const manifestNoOverride: RouteDockManifest = {
    ...baseManifest,
    pricing: { ...baseManifest.pricing!, 'mpp-charge': { amount: '0.001', per: 'request', facilitator: 'https://channels.openzeppelin.com/x402/testnet' } },
  }
  {
    const ctx = paymentContextFromManifest(manifestNoOverride, 'x402', 100_000)
    assert.equal(ctx.payee, resolvePayee(manifestNoOverride, 'x402'))
  }
  {
    const ctx = paymentContextFromManifest(manifestNoOverride, 'mpp-charge', 100_000)
    assert.equal(ctx.payee, resolvePayee(manifestNoOverride, 'mpp-charge'))
  }
}
console.log('✓ per-mode payee override works correctly')

// --- RouteDockClient.pay() rejects Nulth vaults ---

function startTestServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((res) => server.close(() => res())),
      })
    })
  })
}

function stubTrustlineCache(client: RouteDockClient): void {
  const keypair = (client as any).keypair as Keypair
  const network = (client as any).network as string
  const cacheKey = `${network}:${keypair.publicKey()}:USDC`
  ;(RouteDockClient as any)._trustlineCache.set(cacheKey, {
    exists: true,
    expiresAt: Date.now() + 300_000,
  })
}

{
  const signerKp = Keypair.random()
  const manifest = signManifest({
    routedock: '1.0',
    name: 'Nulth Vault Test Provider',
    description: 'Test',
    modes: ['x402'],
    network: 'testnet',
    asset: 'USDC',
    asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    payee: signerKp.publicKey(),
    pricing: { x402: { amount: '0.001', per: 'request', facilitator: 'https://channels.openzeppelin.com/x402/testnet' } },
    endpoints: { price: { method: 'GET', path: '/price' } },
    tags: ['test'],
    vault: 'nulth',
    nulth_account: NULTH,
  }, signerKp.secret())

  const requests: string[] = []
  const server = await startTestServer((req, res) => {
    requests.push(req.url ?? '')
    if (req.url === '/.well-known/routedock.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(manifest))
    } else {
      res.writeHead(404); res.end()
    }
  })

  const client = new RouteDockClient({
    wallet: Keypair.random(),
    network: 'testnet',
    expectedPayee: signerKp.publicKey(),
    vault: { mode: 'nulth', nulthAccount: NULTH, witnessSecret: 'witness', allowedPayees: [PAYEE], dailyCapUsdc: '1.00' },
  })
  stubTrustlineCache(client)

  await assert.rejects(
    () => client.pay(server.url + '/price'),
    (err: unknown) => err instanceof RouteDockSignatureError && /nulth/i.test(err.message) && /not supported/i.test(err.message),
  )
  assert.equal(requests.length, 1, 'server should only receive the manifest request')
  assert.equal(requests[0], '/.well-known/routedock.json', 'only request should be the manifest')
  await server.close()
  console.log('✓ RouteDockClient.pay() rejects Nulth vaults')
}

// --- authorizeEntry rejects Nulth signer ---

{
  const vault = {
    mode: 'nulth' as const,
    nulthAccount: NULTH,
    witnessSecret: 'witness',
    allowedPayees: [PAYEE],
    dailyCapUsdc: '1.00',
  }
  const signerResult = await prepareNulthSigner(vault, baseManifest, 'x402', 'testnet', 100_000)

  let signerCalls = 0
  const signWithNulth = async (preimage: import("@stellar/stellar-sdk").xdr.HashIdPreimage) => {
    signerCalls++
    const result = await signerResult.signer.signAuthEntry(preimage.toXDR('base64'))
    return Buffer.from(result.signedAuthEntry, 'base64')
  }

  // Build a real Soroban authorization entry with transfer invocation
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
    subInvocations: [],
  })
  const entry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(NULTH).toScAddress(),
        nonce: xdr.Int64.fromString('1'),
        signatureExpirationLedger: 300,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: invocation,
  })

  // This should reject because the Nulth signer validates the auth entry as a preimage
  // and rejects it (it's not a base64-encoded auth entry), demonstrating that Nulth signers
  // can't be used with authorizeEntry which passes preimages, not auth entries.
  // See https://github.com/winsznx/routedock/issues/356
  await assert.rejects(
    () => authorizeEntry(entry, signWithNulth, 100_100, Networks.TESTNET),
    /invalid version byte. expected 48, got 16/
  )
  assert.equal(signerCalls, 1)
  console.log('✓ authorizeEntry rejects Nulth signer')
}
