/**
 * Agent vault custody mode — #721.
 *
 * Covers the credential helper, the scheme (IO mocked, everything else real XDR),
 * and `RouteDockClient.pay` with `vault.mode === 'agent-vault'`.
 *
 * Run with: pnpm --filter @routedock/routedock test
 */

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import test from 'node:test'
import { Address, Keypair, Networks, hash, nativeToScVal, xdr } from '@stellar/stellar-sdk'
import type { handleSimulationResult } from '@x402/stellar'
import type { PaymentRequirements } from '@x402/core/types'
import {
  AgentVaultPolicyError,
  AGENT_VAULT_SIGNER_MARKER,
  agentVaultAuthorizeEntry,
  createAgentVaultSigner,
} from '../AgentVault.js'
import {
  AgentVaultStellarScheme,
  selectStellarScheme,
  type NulthPaymentTransaction,
  type NulthSchemeIo,
  type NulthSignAuthEntriesOptions,
  type NulthTransfer,
} from '../nulthScheme.js'
import { RouteDockClient } from '../RouteDockClient.js'
import { InMemorySpendStore } from '../../store/SpendStore.js'
import {
  RouteDockManifestError,
  RouteDockPolicyRejectError,
  RouteDockSignatureError,
} from '../../errors.js'
import { signManifest } from '../../manifest/sign.js'
import type { PaymentResult, RouteDockManifest } from '../../types.js'

const VAULT = 'CAX5IDLC2XHGQSEA2YN3LPLZ7EXLMRXYX3HFJGKFXS6B7OQXBKWO44LT'
const USDC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
// Fixed too: the payee is part of the signed preimage the fixture records.
const PAYEE_KEYPAIR = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 9))
const PAYEE = PAYEE_KEYPAIR.publicKey()
const LEDGER = 50_000
const EXPIRATION = LEDGER + 12
const AMOUNT = '10000'

// Fixed agent seed: ed25519 is deterministic, so the fixture the Rust test
// verifies is reproducible byte for byte.
const FIXTURE_AGENT = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7))
const FIXTURE_DIR = new URL('../../../../../contracts/agent-vault/testdata/ts_auth/', import.meta.url)

const requirements: PaymentRequirements = {
  scheme: 'exact',
  network: 'stellar:testnet',
  asset: USDC,
  amount: AMOUNT,
  payTo: PAYEE,
  maxTimeoutSeconds: 60,
  extra: { areFeesSponsored: true },
}

function unsignedEntry(nonce = '7'): xdr.SorobanAuthorizationEntry {
  return new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: Address.fromString(VAULT).toScAddress(),
        nonce: xdr.Int64.fromString(nonce),
        signatureExpirationLedger: 0,
        signature: xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: Address.fromString(USDC).toScAddress(),
          functionName: 'transfer',
          args: [
            nativeToScVal(VAULT, { type: 'address' }),
            nativeToScVal(PAYEE, { type: 'address' }),
            nativeToScVal(AMOUNT, { type: 'i128' }),
          ],
        }),
      ),
      subInvocations: [],
    }),
  })
}

function preimageOf(entry: xdr.SorobanAuthorizationEntry, expiration: number): xdr.HashIdPreimage {
  const credentials = entry.credentials().address()
  return xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: hash(Buffer.from(Networks.TESTNET)),
      nonce: credentials.nonce(),
      invocation: entry.rootInvocation(),
      signatureExpirationLedger: expiration,
    }),
  )
}

// ── Acceptance 1: the credential ─────────────────────────────────────────────

test('agentVaultAuthorizeEntry writes a 64-byte scvBytes signature that verifies over sha256(preimage)', async () => {
  const agent = Keypair.random()
  const signed = await agentVaultAuthorizeEntry(unsignedEntry(), agent, EXPIRATION, Networks.TESTNET)

  const credentials = signed.credentials().address()
  assert.equal(credentials.signatureExpirationLedger(), EXPIRATION)

  const signature = credentials.signature()
  assert.equal(signature.switch().name, 'scvBytes', 'raw bytes, not Vec<Map{public_key, signature}>')
  const bytes = signature.bytes()
  assert.equal(bytes.length, 64)

  const digest = hash(preimageOf(unsignedEntry(), EXPIRATION).toXDR())
  assert.ok(agent.verify(digest, bytes), 'verifies with the agent public key over sha256(preimage)')
  assert.ok(!Keypair.random().verify(digest, bytes), 'and not with another key')
})

test('agentVaultAuthorizeEntry accepts a signing callback and leaves the input entry untouched', async () => {
  const agent = Keypair.random()
  const entry = unsignedEntry()
  const signed = await agentVaultAuthorizeEntry(
    entry,
    async (preimage) => agent.sign(hash(preimage.toXDR())),
    EXPIRATION,
    Networks.TESTNET,
  )
  assert.equal(signed.credentials().address().signature().switch().name, 'scvBytes')
  assert.equal(entry.credentials().address().signature().switch().name, 'scvVoid', 'cloned, not mutated')
})

test('agentVaultAuthorizeEntry rejects what the vault could not verify', async () => {
  await assert.rejects(
    () => agentVaultAuthorizeEntry(unsignedEntry(), async () => Buffer.alloc(32), EXPIRATION, Networks.TESTNET),
    /64 bytes/,
  )
  await assert.rejects(
    () => agentVaultAuthorizeEntry(unsignedEntry(), Keypair.random(), EXPIRATION),
    /network passphrase/,
  )
  const gEntry = unsignedEntry()
  gEntry.credentials().address().address(Address.fromString(PAYEE).toScAddress())
  await assert.rejects(
    () => agentVaultAuthorizeEntry(gEntry, Keypair.random(), EXPIRATION, Networks.TESTNET),
    /contract accounts \(C\.\.\.\)/,
  )
})

// Fixture for the Rust test (contracts/agent-vault). Regenerate with
// UPDATE_AGENT_VAULT_FIXTURE=1; otherwise the committed bytes must match what
// the helper produces now, so the TS and Rust sides cannot drift apart.
test('agentVaultAuthorizeEntry output matches the fixture the contract test decodes', async () => {
  const signed = await agentVaultAuthorizeEntry(
    unsignedEntry(),
    FIXTURE_AGENT,
    EXPIRATION,
    Networks.TESTNET,
  )
  const files = {
    'agent_pk.hex': Buffer.from(FIXTURE_AGENT.rawPublicKey()).toString('hex'),
    'payload.hex': Buffer.from(hash(preimageOf(unsignedEntry(), EXPIRATION).toXDR())).toString('hex'),
    'signature.hex': Buffer.from(signed.credentials().address().signature().bytes()).toString('hex'),
  }
  for (const [name, hex] of Object.entries(files)) {
    const url = new URL(name, FIXTURE_DIR)
    if (process.env['UPDATE_AGENT_VAULT_FIXTURE'] === '1') writeFileSync(url, `${hex}\n`)
    assert.equal(readFileSync(url, 'utf8').trim(), hex, name)
  }
})

// ── Acceptance 2: the scheme re-simulates after signing ──────────────────────

const okSimulation = {
  latestLedger: LEDGER,
  latestLedgerSequence: LEDGER,
  cost: { cpuInsns: '1', memBytes: '1' },
  transactionData: '',
} as unknown as Parameters<typeof handleSimulationResult>[0]

class StubTransaction implements NulthPaymentTransaction {
  entries: xdr.SorobanAuthorizationEntry[] = [unsignedEntry()]
  footprint = 'recorded-footprint'
  readonly log: string[] = []
  readonly signAuthEntriesCalls: NulthSignAuthEntriesOptions[] = []
  /** What the next simulate() does; set to make the enforcing simulation fail. */
  simulateError: Error | undefined

  get built(): { toXDR(): string } {
    const { entries, footprint } = this
    return {
      toXDR: () => `${footprint}|${entries.map((entry) => entry.toXDR('base64')).join(',')}`,
    }
  }

  get simulation(): NulthPaymentTransaction['simulation'] {
    return okSimulation
  }

  needsNonInvokerSigningBy(): string[] {
    return this.entries
      .filter((entry) => entry.credentials().address().signature().switch().name === 'scvVoid')
      .map((entry) => Address.fromScAddress(entry.credentials().address().address()).toString())
  }

  async signAuthEntries(options: NulthSignAuthEntriesOptions): Promise<void> {
    this.log.push('sign')
    this.signAuthEntriesCalls.push(options)
    const { address, expiration, signAuthEntry, authorizeEntry } = options
    if (!address || !signAuthEntry || !authorizeEntry) throw new Error('missing option')
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
    this.log.push('simulate')
    if (this.simulateError) throw this.simulateError
    // The enforcing simulation runs __check_auth, which is what adds the vault
    // instance and spend-counter keys to the footprint.
    this.footprint = 'resimulated-footprint-with-vault-and-spend-counters'
    return this
  }
}

function stubIo(tx: StubTransaction, assembled: NulthTransfer[] = []): NulthSchemeIo {
  return {
    async expirationLedger() {
      return EXPIRATION
    },
    async assemble(transfer) {
      assembled.push(transfer)
      return tx
    },
  }
}

test('AgentVaultStellarScheme signs with the agent key, then re-simulates and returns the new footprint', async () => {
  const agent = Keypair.random()
  const signer = createAgentVaultSigner({ mode: 'agent-vault', vaultContract: VAULT, agentSecret: agent })
  const assembled: NulthTransfer[] = []
  const tx = new StubTransaction()

  const result = await new AgentVaultStellarScheme(signer, stubIo(tx, assembled)).createPaymentPayload(
    2,
    requirements,
  )

  assert.equal(assembled[0]?.from, VAULT, 'the vault, not the agent G... key, is the payer')
  assert.equal(tx.signAuthEntriesCalls[0]?.authorizeEntry, agentVaultAuthorizeEntry)
  assert.deepEqual(tx.log, ['sign', 'simulate'], 're-simulated after, not before, signing')

  const transaction = String(result.payload.transaction)
  assert.ok(
    transaction.startsWith('resimulated-footprint-with-vault-and-spend-counters|'),
    'the payload carries the re-simulated footprint, not the recorded one',
  )

  const credentials = tx.entries[0]!.credentials().address()
  assert.equal(credentials.signatureExpirationLedger(), EXPIRATION)
  const bytes = credentials.signature().bytes()
  assert.equal(bytes.length, 64)
  assert.ok(agent.verify(hash(preimageOf(unsignedEntry(), EXPIRATION).toXDR()), bytes))
})

test('selectStellarScheme routes an agent vault signer to the vault scheme', () => {
  const signer = createAgentVaultSigner({ mode: 'agent-vault', vaultContract: VAULT, agentSecret: Keypair.random() })
  assert.equal(signer[AGENT_VAULT_SIGNER_MARKER], 'agent-vault')
  assert.equal(signer.address, VAULT)
  assert.ok(selectStellarScheme(signer) instanceof AgentVaultStellarScheme)
})

// ── Acceptance 3 (client side): pay() and the #4 mapping ─────────────────────

function startTestServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      })
    })
  })
}

function makeManifest(
  modes: Array<'x402' | 'mpp-charge' | 'mpp-session'> = ['x402'],
  overrides: Partial<RouteDockManifest> = {},
): RouteDockManifest {
  const pricing: RouteDockManifest['pricing'] = {}
  if (modes.includes('x402')) {
    pricing.x402 = { amount: '0.001', per: 'request', facilitator: 'https://facilitator.test' }
  }
  if (modes.includes('mpp-charge')) pricing['mpp-charge'] = { amount: '0.001', per: 'request' }
  if (modes.includes('mpp-session')) {
    pricing['mpp-session'] = {
      rate: '0.0001',
      per: 'voucher',
      channel_factory: USDC,
      min_deposit: '0.10',
      refund_waiting_period_ledgers: 17_280,
    }
  }
  return signManifest(
    {
      routedock: '1.0',
      name: 'Agent Vault Test',
      description: 'agent vault client tests',
      modes,
      network: 'testnet',
      asset: 'USDC',
      asset_contract: USDC,
      payee: PAYEE,
      pricing,
      endpoints: { test: { method: 'GET', path: '/test' } },
      tags: ['test'],
      ...overrides,
    } as RouteDockManifest,
    PAYEE_KEYPAIR.secret(),
  )
}

function manifestHandler(manifest: RouteDockManifest) {
  return (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/.well-known/routedock.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(manifest))
    } else {
      res.writeHead(404)
      res.end()
    }
  }
}

type ClientInternals = { keypair: Keypair; network: 'testnet' | 'mainnet'; x402: unknown }
type ClientStatics = { _trustlineCache: Map<string, { exists: true; expiresAt: number }> }

function makeClient(): { client: RouteDockClient; paid: string[] } {
  const client = new RouteDockClient({
    wallet: Keypair.random(),
    network: 'testnet',
    spendStore: new InMemorySpendStore({ warn: false }),
    vault: { mode: 'agent-vault', vaultContract: VAULT, agentSecret: Keypair.random() },
  })
  const { keypair, network } = client as unknown as ClientInternals
  ;(RouteDockClient as unknown as ClientStatics)._trustlineCache.set(
    `${network}:${keypair.publicKey()}:USDC`,
    { exists: true, expiresAt: Date.now() + 300_000 },
  )
  return { client, paid: [] }
}

/**
 * Replace the x402 sub-client: no HTTP, but the signer the client builds and the
 * real vault scheme still run, and a signing failure is wrapped exactly as
 * `X402Client` wraps it.
 */
function installX402(client: RouteDockClient, tx: StubTransaction, payers: string[]): void {
  ;(client as unknown as ClientInternals).x402 = {
    withSigner: (signer: ReturnType<typeof createAgentVaultSigner>) => ({
      async pay(): Promise<PaymentResult> {
        payers.push(signer.address)
        try {
          await new AgentVaultStellarScheme(signer, stubIo(tx)).createPaymentPayload(2, requirements)
        } catch (err) {
          throw new RouteDockSignatureError(`x402 payment signing failed: ${String(err)}`, { cause: err })
        }
        return { data: { ok: true }, txHash: 'deadbeef', mode: 'x402', amount: '0.001', timestamp: Date.now() }
      },
    }),
  }
}

test('RouteDockClient pays an x402 endpoint from the agent vault', async () => {
  const server = await startTestServer(manifestHandler(makeManifest()))
  try {
    const { client } = makeClient()
    const tx = new StubTransaction()
    const payers: string[] = []
    installX402(client, tx, payers)

    const result = await client.pay(`${server.url}/test`)

    assert.equal(result.mode, 'x402')
    assert.deepEqual(payers, [VAULT], 'paid from the vault contract')
    assert.deepEqual(tx.log, ['sign', 'simulate'])
  } finally {
    await server.close()
  }
})

test('a simulated Error(Contract, #4) becomes RouteDockPolicyRejectError', async () => {
  const server = await startTestServer(manifestHandler(makeManifest()))
  try {
    const { client } = makeClient()
    const tx = new StubTransaction()
    tx.simulateError = new Error(
      'HostError: Error(Contract, #4)\nEvent log: contract try-call failed in __check_auth',
    )
    installX402(client, tx, [])

    await assert.rejects(
      () => client.pay(`${server.url}/test`),
      (err: unknown) => {
        assert.ok(err instanceof RouteDockPolicyRejectError, String(err))
        assert.equal((err as RouteDockPolicyRejectError).reason, 'vault_daily_cap_exceeded')
        assert.ok((err as RouteDockPolicyRejectError).cause instanceof RouteDockSignatureError)
        return true
      },
    )
  } finally {
    await server.close()
  }
})

test('simulated vault errors #3, #5 and #9 map to their policy reasons; other codes stay untyped', async () => {
  const { mapAgentVaultSimulationError } = await import('../AgentVault.js')
  const reason = (code: number) =>
    mapAgentVaultSimulationError(new Error(`Error(Contract, #${code})`))?.reason
  assert.equal(reason(3), 'vault_session_expired')
  assert.equal(reason(5), 'vault_payee_not_allowed')
  assert.equal(reason(9), 'vault_frozen')
  assert.equal(reason(12), undefined)
  assert.ok(mapAgentVaultSimulationError(new Error('Error(Contract, #4)')) instanceof AgentVaultPolicyError)
})

test('agent-vault refuses the modes it cannot pay from the vault', async () => {
  const server = await startTestServer(manifestHandler(makeManifest(['x402', 'mpp-charge', 'mpp-session'])))
  try {
    const { client } = makeClient()
    installX402(client, new StubTransaction(), [])

    await assert.rejects(
      () => client.pay(`${server.url}/test`, { forceMode: 'mpp-charge' }),
      /agent-vault currently supports x402 mode only/,
    )
    await assert.rejects(
      () => client.openSession(`${server.url}/test`),
      (err: unknown) => err instanceof RouteDockManifestError && /agent-vault does not support/.test(err.message),
    )
  } finally {
    await server.close()
  }
})

test('agent-vault config is validated up front', () => {
  const base = { wallet: Keypair.random(), network: 'testnet' as const }
  assert.throws(
    () => new RouteDockClient({ ...base, vault: { mode: 'agent-vault', vaultContract: PAYEE, agentSecret: Keypair.random() } }),
    /C\.\.\. strkey/,
  )
  assert.throws(
    () => new RouteDockClient({ ...base, vault: { mode: 'agent-vault', vaultContract: VAULT, agentSecret: 'nope' } }),
    /valid Stellar secret key/,
  )
})

test('agent-vault refuses a provider on another network or custody mode', async () => {
  for (const overrides of [{ network: 'mainnet' as const }, { vault: 'nulth' as const }]) {
    const server = await startTestServer(manifestHandler(makeManifest(['x402'], overrides)))
    try {
      const { client } = makeClient()
      installX402(client, new StubTransaction(), [])
      await assert.rejects(() => client.pay(`${server.url}/test`), RouteDockManifestError)
    } finally {
      await server.close()
    }
  }
})
