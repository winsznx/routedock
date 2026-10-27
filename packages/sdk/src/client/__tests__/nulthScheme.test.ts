/**
 * Nulth x402 scheme client — #552.
 *
 * The two steps that need Soroban RPC are injected; everything else (the auth
 * entries, the credential write, the transaction envelope) is real XDR.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  Address,
  Keypair,
  Networks,
  nativeToScVal,
  xdr,
} from '@stellar/stellar-sdk'
import { ExactStellarScheme, handleSimulationResult, type ClientStellarSigner } from '@x402/stellar'
import { x402Client } from '@x402/core/client'
import type { Network, PaymentRequirements, SchemeNetworkClient } from '@x402/core/types'
import {
  createNulthSigner,
  createPolicyState,
  decodeNulthProofScVal,
  nulthAuthorizeEntry,
  setNulthPaymentContext,
  type NulthStellarSigner,
} from '@routedock/nulth-sdk'
import {
  NulthStellarScheme,
  selectStellarScheme,
  type NulthPaymentTransaction,
  type NulthSchemeIo,
  type NulthSignAuthEntriesOptions,
  type NulthTransfer,
} from '../nulthScheme.js'
import { X402Client } from '../x402Client.js'
import { prepareNulthSigner, type NulthVaultConfig } from '../NulthVault.js'
import type { RouteDockManifest } from '../../types.js'

const NULTH_ACCOUNT = 'CAX5IDLC2XHGQSEA2YN3LPLZ7EXLMRXYX3HFJGKFXS6B7OQXBKWO44LT'
const PAYEE = 'GDHLJWBM6Z2Y4KF6Z4JAFIUUO2KAXAJ6MAIUK2XMGBQ7ZUUZ7HFPW2BK'
const INVOKER = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
const USDC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const LEDGER = 50_000
const EXPIRATION = LEDGER + 12
const AMOUNT = '10000'

const requirements: PaymentRequirements = {
  scheme: 'exact',
  network: 'stellar:testnet',
  asset: USDC,
  amount: AMOUNT,
  payTo: PAYEE,
  maxTimeoutSeconds: 60,
  extra: { areFeesSponsored: true },
}

/** A successful simulation is all `handleSimulationResult` inspects. */
const okSimulation: Parameters<typeof handleSimulationResult>[0] = {
  latestLedger: LEDGER,
  latestLedgerSequence: LEDGER,
  cost: { cpuInsns: '1', memBytes: '1' },
  transactionData: '',
} as unknown as Parameters<typeof handleSimulationResult>[0]

function hostFunction(): xdr.InvokeContractArgs {
  return new xdr.InvokeContractArgs({
    contractAddress: Address.fromString(USDC).toScAddress(),
    functionName: 'transfer',
    args: [
      nativeToScVal(NULTH_ACCOUNT, { type: 'address' }),
      nativeToScVal(PAYEE, { type: 'address' }),
      nativeToScVal(AMOUNT, { type: 'i128' }),
    ],
  })
}

function transferInvocation(): xdr.SorobanAuthorizedInvocation {
  return new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      hostFunction(),
    ),
    subInvocations: [],
  })
}

function unsignedEntry(): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(NULTH_ACCOUNT).toScAddress(),
        nonce: xdr.Int64.fromString('7'),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: transferInvocation(),
  })
}

function nulthSigner(): NulthStellarSigner {
  const config = {
    nulthAccount: NULTH_ACCOUNT,
    network: 'testnet' as const,
    prover: 'mock' as const,
    policy: createPolicyState({
      dailyCapUsdc: '1.00',
      allowedPayees: [PAYEE],
      witnessSecret: 'test-witness-secret',
      ledgerSequence: LEDGER,
    }),
  }
  setNulthPaymentContext(config, {
    payee: PAYEE,
    amountStroops: BigInt(AMOUNT),
    assetContract: USDC,
    ledgerSequence: LEDGER,
  })
  return createNulthSigner(config)
}

/**
 * Stands in for `AssembledTransaction`. `signAuthEntries` mirrors what
 * stellar-sdk 14.6.1 does: it wraps the signer into a preimage-to-bytes callback
 * and hands both that and `authorizeEntry` the entry.
 */
class StubTransaction implements NulthPaymentTransaction {
  entries: xdr.SorobanAuthorizationEntry[] = [unsignedEntry()]
  readonly signAuthEntriesCalls: NulthSignAuthEntriesOptions[] = []
  readonly simulateCalls: number[] = []

  get built(): { toXDR(): string } {
    const entries = this.entries
    return { toXDR: () => entries.map((entry) => entry.toXDR('base64')).join(',') }
  }

  get simulation(): NulthPaymentTransaction['simulation'] {
    return okSimulation
  }

  needsNonInvokerSigningBy(): string[] {
    return this.entries
      .filter((entry) => {
        const credentials = entry.credentials()
        return (
          credentials.switch() === xdr.SorobanCredentialsType.sorobanCredentialsAddress() &&
          credentials.address().signature().switch().name === 'scvVoid'
        )
      })
      .map((entry) => Address.fromScAddress(entry.credentials().address().address()).toString())
  }

  async signAuthEntries(options: NulthSignAuthEntriesOptions): Promise<void> {
    this.signAuthEntriesCalls.push(options)
    const { address, expiration, signAuthEntry, authorizeEntry } = options
    if (!address || !signAuthEntry || !authorizeEntry) {
      throw new Error('the scheme must pass address, signAuthEntry, and authorizeEntry')
    }
    const validUntil = await Promise.resolve(expiration ?? 0)
    this.entries = await Promise.all(
      this.entries.map((entry) =>
        authorizeEntry(
          entry,
          async (preimage: xdr.HashIdPreimage) => {
            const { signedAuthEntry } = await signAuthEntry(preimage.toXDR('base64'), { address })
            return Buffer.from(signedAuthEntry, 'base64')
          },
          validUntil,
          Networks.TESTNET,
        ),
      ),
    )
  }

  async simulate(): Promise<unknown> {
    this.simulateCalls.push(1)
    return this
  }
}

function stubIo(tx: StubTransaction, assembled: NulthTransfer[]): NulthSchemeIo {
  return {
    async expirationLedger(network, maxTimeoutSeconds) {
      assert.equal(network, 'stellar:testnet')
      assert.equal(maxTimeoutSeconds, 60)
      return EXPIRATION
    },
    async assemble(transfer) {
      assembled.push(transfer)
      return tx
    },
  }
}

const offlineIo: NulthSchemeIo = {
  async expirationLedger(): Promise<number> {
    throw new Error('must not reach the network')
  },
  async assemble(): Promise<NulthPaymentTransaction> {
    throw new Error('must not reach the network')
  },
}

// ── The scheme builds, signs, and returns a real envelope ────────────────────

test('NulthStellarScheme puts the proof in the payment transaction credential', async () => {
  const assembled: NulthTransfer[] = []
  const tx = new StubTransaction()
  const scheme = new NulthStellarScheme(nulthSigner(), stubIo(tx, assembled))

  assert.equal(scheme.scheme, 'exact', 'the requirement this scheme answers')
  const payload = await scheme.createPaymentPayload(2, requirements)

  assert.deepEqual(assembled, [
    {
      asset: USDC,
      from: NULTH_ACCOUNT,
      payTo: PAYEE,
      amount: AMOUNT,
      networkPassphrase: Networks.TESTNET,
      rpcUrl: 'https://soroban-testnet.stellar.org',
    },
  ])

  const [options] = tx.signAuthEntriesCalls
  assert.equal(options?.address, NULTH_ACCOUNT, 'signs the Nulth account credential')
  assert.equal(options?.expiration, EXPIRATION, 'expiry from the requirement timeout')
  assert.equal(options?.authorizeEntry, nulthAuthorizeEntry, 'not stellar-base ed25519 authorizing')
  assert.equal(tx.simulateCalls.length, 1, 're-simulated so __check_auth is in the footprint')

  const [entry] = tx.entries
  assert.ok(entry, 'the envelope carries the Nulth auth entry')
  assert.equal(
    payload.payload.transaction,
    tx.entries.map((signed) => signed.toXDR('base64')).join(','),
    'the payload is the envelope holding the signed credential',
  )

  const credentials = entry.credentials().address()
  assert.equal(credentials.signatureExpirationLedger(), EXPIRATION)
  const proof = decodeNulthProofScVal(credentials.signature())
  assert.equal(proof.nulth, 'zk-v1')
  assert.equal(proof.proof.publicInputs.amountStroops, AMOUNT)
  assert.equal(proof.proof.publicInputs.payeeHash.length, 64, 'the payee stays hashed')
})

// ── Scheme selection: only Nulth payers change behaviour ─────────────────────

test('selectStellarScheme keeps ed25519 payers on the stock scheme', () => {
  const signer: ClientStellarSigner = {
    address: Keypair.random().publicKey(),
    signAuthEntry: async () => ({ signedAuthEntry: '' }),
  }
  assert.ok(selectStellarScheme(signer) instanceof ExactStellarScheme)
  assert.ok(selectStellarScheme(nulthSigner()) instanceof NulthStellarScheme)
})

test('X402Client.withSigner registers the proof scheme for stellar:testnet', async (t) => {
  const vault: NulthVaultConfig = {
    mode: 'nulth',
    nulthAccount: NULTH_ACCOUNT,
    witnessSecret: 'test-witness-secret',
    allowedPayees: [PAYEE],
    dailyCapUsdc: '1.00',
  }
  const manifest = {
    routedock: '1.0',
    name: 'Nulth Scheme Test',
    description: 'test',
    modes: ['x402'],
    network: 'testnet',
    asset: 'USDC',
    asset_contract: USDC,
    payee: PAYEE,
    pricing: { x402: { amount: '0.01', per: 'request', facilitator: 'https://facilitator.test' } },
    endpoints: {},
    tags: ['test'],
  } as unknown as RouteDockManifest

  const { signer } = await prepareNulthSigner(vault, manifest, 'x402', 'testnet', LEDGER)

  // Record what the client hands to the core, then register for real. Node's
  // mock call records changed shape between 22 and 24, so the arguments are
  // captured here instead of read back off the mock.
  const registered: Array<[Network, SchemeNetworkClient]> = []
  const register = x402Client.prototype.register
  t.mock.method(
    x402Client.prototype,
    'register',
    function (this: x402Client, network: Network, client: SchemeNetworkClient) {
      registered.push([network, client])
      return register.call(this, network, client)
    },
  )
  new X402Client(Keypair.random().secret(), 'testnet').withSigner(signer)

  const [ed25519Registration, nulthRegistration] = registered
  assert.deepEqual(
    registered.map(([network]) => network),
    ['stellar:testnet', 'stellar:testnet'],
    'withSigner rebuilds the client once per construction, on the same network',
  )
  assert.ok(
    ed25519Registration?.[1] instanceof ExactStellarScheme,
    'an ed25519 payer keeps the stock scheme',
  )
  assert.ok(
    nulthRegistration?.[1] instanceof NulthStellarScheme,
    `the vault signer must pay through the proof scheme, got ` +
      `${nulthRegistration?.[1]?.constructor.name}`,
  )
})

// ── Guards ───────────────────────────────────────────────────────────────────

test('NulthStellarScheme rejects requirements it cannot settle before any network call', async () => {
  const scheme = new NulthStellarScheme(nulthSigner(), offlineIo)

  await assert.rejects(
    () => scheme.createPaymentPayload(2, { ...requirements, extra: {} }),
    /areFeesSponsored/,
  )
  await assert.rejects(
    () => scheme.createPaymentPayload(2, { ...requirements, amount: '0' }),
    /positive integer/,
  )
  await assert.rejects(
    () => scheme.createPaymentPayload(2, { ...requirements, scheme: 'cctp' }),
    /Unsupported scheme/,
  )
  await assert.rejects(
    () => scheme.createPaymentPayload(2, { ...requirements, asset: PAYEE }),
    /Invalid Stellar asset address/,
  )
})

test('NulthStellarScheme refuses a transaction it does not hold the signer for', async () => {
  const unsigned: NulthPaymentTransaction = {
    built: { toXDR: () => 'x' },
    simulation: okSimulation,
    needsNonInvokerSigningBy: () => [INVOKER],
    signAuthEntries: async () => {},
    simulate: async () => unsigned,
  }
  const scheme = new NulthStellarScheme(nulthSigner(), {
    async expirationLedger() {
      return EXPIRATION
    },
    async assemble() {
      return unsigned
    },
  })

  await assert.rejects(
    () => scheme.createPaymentPayload(2, requirements),
    /Expected to sign with \[CAX5.*\], but got \[GBBD/,
  )
})

test('NulthStellarScheme refuses a transaction that still needs another signer', async () => {
  const tx = new StubTransaction()
  let reSimulated = false
  const trailing: NulthPaymentTransaction = {
    get built() {
      return tx.built
    },
    get simulation() {
      return tx.simulation
    },
    needsNonInvokerSigningBy: () => (reSimulated ? [INVOKER] : tx.needsNonInvokerSigningBy()),
    signAuthEntries: (options) => tx.signAuthEntries(options),
    simulate: async () => {
      reSimulated = true
      return trailing
    },
  }

  const scheme = new NulthStellarScheme(nulthSigner(), {
    async expirationLedger() {
      return EXPIRATION
    },
    async assemble() {
      return trailing
    },
  })

  await assert.rejects(
    () => scheme.createPaymentPayload(2, requirements),
    /unexpected signer\(s\) required/,
  )
})
