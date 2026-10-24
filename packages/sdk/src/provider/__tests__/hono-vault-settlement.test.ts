/**
 * Hono mpp-session: session_settled is recorded on the agent vault after a
 * clean close (issue #555).
 *
 * `recordSessionSettlement` talks to a Soroban RPC through the dynamically
 * imported `@stellar/stellar-sdk/rpc` Server — this file mocks that module
 * (plus `@stellar/mpp/channel/server`) so the whole build/prepare/sign/send/
 * confirm flow runs without a network round trip, in its own process, leaving
 * the real hono.test.ts unaffected.
 */

import { mock, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import {
  Account,
  Keypair,
  Networks,
  scValToNative,
  StrKey,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk'
import type { RouteDockManifest } from '../../types.js'
import type { RouteDockLogLevel, RouteDockLogFields } from '../../internal/logger.js'

const payeeKeypair = Keypair.random()
const commitKeypair = Keypair.random()
const payerKeypair = Keypair.random()
// `new Contract()` rejects account (G...) addresses, so mint a contract id.
const VAULT = StrKey.encodeContract(Keypair.random().rawPublicKey())

const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const CHANNEL_CONTRACT = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'

// ---------------------------------------------------------------------------
// @stellar/mpp/channel/server mock — close always succeeds, the channel
// method is never reached (only the DELETE path runs here).
// ---------------------------------------------------------------------------

mock.module('@stellar/mpp/channel/server', {
  namedExports: {
    Store: {
      memory: () => {
        const m = new Map<string, unknown>()
        return {
          async get(k: string) { return m.get(k) },
          async put(k: string, v: unknown) { m.set(k, v) },
          async delete(k: string) { m.delete(k) },
          update(k: string, fn: (v: unknown) => unknown) { m.set(k, fn(m.get(k))) },
        }
      },
    },
    close: async () => 'mock-close-tx-hash',
    stellar: () => [],
  },
})

// Capture `commit` so the test can feed in verified vouchers without building
// a full signed credential (same trick as hono-orphan-close.test.ts).
const actualCompat = await import('../mppCompatibility.js')
type Commit = (credential: { payload?: unknown; source?: string }) => void | Promise<void>
let capturedCommit: Commit | null = null
mock.module('../mppCompatibility.js', {
  namedExports: {
    channelAuthorizer: actualCompat.channelAuthorizer,
    withTypedChannelErrors: actualCompat.withTypedChannelErrors,
    formatMppError: actualCompat.formatMppError,
    onVerifiedCredential: (method: unknown, commit: Commit) => {
      capturedCommit = commit
      return method
    },
  },
})

// ---------------------------------------------------------------------------
// @stellar/stellar-sdk/rpc mock — records every call the settlement helper
// makes and returns the statuses each test configures.
// ---------------------------------------------------------------------------

interface RpcState {
  urls: string[]
  getAccountCalls: string[]
  preparedTx: Transaction | null
  sentTx: Transaction | null
  sendStatus: 'PENDING' | 'ERROR'
  sendErrorResult: unknown
  txStatus: string
}

const rpc: RpcState = {
  urls: [],
  getAccountCalls: [],
  preparedTx: null,
  sentTx: null,
  sendStatus: 'PENDING',
  sendErrorResult: undefined,
  txStatus: 'SUCCESS',
}

function resetRpc(): void {
  rpc.urls = []
  rpc.getAccountCalls = []
  rpc.preparedTx = null
  rpc.sentTx = null
  rpc.sendStatus = 'PENDING'
  rpc.sendErrorResult = undefined
  rpc.txStatus = 'SUCCESS'
}

class MockSorobanServer {
  async getAccount(publicKey: string): Promise<Account> {
    rpc.getAccountCalls.push(publicKey)
    return new Account(publicKey, '0')
  }
  async prepareTransaction(tx: Transaction): Promise<Transaction> {
    rpc.preparedTx = tx
    return tx
  }
  async sendTransaction(tx: Transaction): Promise<{ status: string; hash: string; errorResult?: unknown }> {
    rpc.sentTx = tx
    return {
      status: rpc.sendStatus,
      hash: tx.hash().toString('hex'),
      ...(rpc.sendErrorResult !== undefined ? { errorResult: rpc.sendErrorResult } : {}),
    }
  }
  async getTransaction(): Promise<{ status: string }> {
    return { status: rpc.txStatus }
  }
}

// The settlement helper builds its RPC client through the internal vaultRpc
// seam — mock that instead of @stellar/stellar-sdk/rpc itself, whose CJS
// exports node:test module mocks cannot redefine.
mock.module('../internal/vaultRpc.js', {
  namedExports: {
    createSorobanRpcServer: async (rpcUrl: string) => {
      rpc.urls.push(rpcUrl)
      return new MockSorobanServer()
    },
  },
})

const { routedockHono } = await import('../hono.js')

// The deprecated env fallback must never fire unless a test asks for it.
delete process.env.AGENT_VAULT_CONTRACT
delete process.env.AGENT_VAULT_CONTRACT_ID

const manifest: RouteDockManifest = {
  routedock: '1.0',
  name: 'Vault Settlement Test Service',
  description: 'Unit test provider',
  modes: ['mpp-session'],
  network: 'testnet',
  asset: 'USDC',
  asset_contract: ASSET_CONTRACT,
  payee: payeeKeypair.publicKey(),
  pricing: {
    'mpp-session': {
      rate: '0.0001',
      per: 'voucher',
      channel_factory: CHANNEL_CONTRACT,
      min_deposit: '0.10',
      refund_waiting_period_ledgers: 17280,
    },
  },
  endpoints: { price: { method: 'GET', path: '/price' } },
  tags: ['test'],
}

interface LogLine {
  level: RouteDockLogLevel
  message: string
  fields?: RouteDockLogFields | undefined
}

function makeApp(
  extra: {
    vaultSettlement?: { contract: string; rpcUrl?: string }
    waitUntil?: (p: Promise<unknown>) => void
    onCallbackError?: (err: unknown, cbName: string) => void
    logs?: LogLine[]
  } = {},
): Hono {
  const app = new Hono()
  app.use(
    '*',
    routedockHono({
      modes: ['mpp-session'],
      pricing: { 'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT } },
      asset: 'USDC',
      assetContract: ASSET_CONTRACT,
      payee: payeeKeypair.publicKey(),
      network: 'testnet',
      payeeSecretKey: payeeKeypair.secret(),
      commitmentPublicKey: commitKeypair.publicKey(),
      manifest,
      ...(extra.logs
        ? { logger: (level, message, fields) => { extra.logs!.push({ level, message, fields }) } }
        : {}),
      ...(extra.vaultSettlement ? { vaultSettlement: extra.vaultSettlement } : {}),
      ...(extra.waitUntil ? { waitUntil: extra.waitUntil } : {}),
      ...(extra.onCallbackError ? { onCallbackError: extra.onCallbackError } : {}),
    }),
  )
  return app
}

function deleteClose(): Request {
  return new Request('http://localhost/price', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ amount: '5000', signature: 'ff'.repeat(32) }),
  })
}

/**
 * Re-parse a built transaction so its operations carry decoded `type`/`func`
 * fields, then return the contract function name and args of the only
 * operation. Built (non-parsed) operations leave `func` unpopulated.
 */
function hostCall(tx: Transaction): { fn: string; args: unknown[] } {
  const parsed = TransactionBuilder.fromXDR(tx.toXDR(), Networks.TESTNET)
  assert.equal(parsed.operations.length, 1, 'exactly one operation expected')

  const op = parsed.operations[0] as unknown as {
    type?: string
    func?: { invokeContract(): unknown }
  }
  assert.equal(op.type, 'invokeHostFunction')

  const func = op.func
  assert.ok(func, 'operation should carry a host function')
  const invoke = func.invokeContract() as unknown as {
    functionName(): string | Buffer
    args(): Array<Parameters<typeof scValToNative>[0]>
  }
  const rawName = invoke.functionName()
  return {
    fn: typeof rawName === 'string' ? rawName : Buffer.from(rawName).toString(),
    args: invoke.args().map(a => scValToNative(a)),
  }
}

describe('routedockHono — vault session settlement on clean close', () => {
  it('#given no vaultSettlement option #when a session closes cleanly #then no vault RPC call is made', async () => {
    resetRpc()
    const waits: Promise<unknown>[] = []
    const app = makeApp({ waitUntil: (p) => { waits.push(p) } })

    assert.ok(capturedCommit, 'onVerifiedCredential mock should have captured commit')
    await capturedCommit!({ payload: { amount: '5000', signature: 'ff'.repeat(32) }, source: payerKeypair.publicKey() })

    const res = await app.request(deleteClose())
    assert.equal(res.status, 200)
    const body = (await res.json()) as { closeTxHash: string | null }
    assert.equal(body.closeTxHash, 'mock-close-tx-hash')

    assert.equal(waits.length, 0, 'no background settlement promise should exist')
    assert.equal(rpc.urls.length, 0, 'no RPC client should have been constructed')
    assert.equal(rpc.getAccountCalls.length, 0)
    assert.equal(rpc.preparedTx, null)
    assert.equal(rpc.sentTx, null)
  })

  it('#given the vaultSettlement option #when a session closes cleanly #then record_session_settlement is built with the session\'s channel, payer, payee, amount and voucher count', async () => {
    resetRpc()
    const waits: Promise<unknown>[] = []
    const app = makeApp({
      vaultSettlement: { contract: VAULT },
      waitUntil: (p) => { waits.push(p) },
    })

    // Two verified vouchers — the record must carry voucher count 2.
    await capturedCommit!({ payload: { amount: '3000', signature: 'aa'.repeat(32) }, source: payerKeypair.publicKey() })
    await capturedCommit!({ payload: { amount: '5000', signature: 'ff'.repeat(32) }, source: payerKeypair.publicKey() })

    const res = await app.request(deleteClose())
    assert.equal(res.status, 200)

    assert.equal(waits.length, 1, 'settlement promise must be handed to waitUntil')
    await waits[0]

    assert.deepEqual(rpc.urls, ['https://soroban-testnet.stellar.org'], 'default testnet RPC endpoint')
    assert.deepEqual(rpc.getAccountCalls, [payeeKeypair.publicKey()], 'tx sourced from the payee')
    assert.ok(rpc.preparedTx, 'settlement transaction should have been prepared')
    assert.equal(rpc.sentTx, rpc.preparedTx, 'the prepared transaction should be the one sent')

    const { fn, args } = hostCall(rpc.preparedTx)
    assert.equal(fn, 'record_session_settlement')
    // (channel_id, payer, payee, cumulative_amount, voucher_count)
    assert.deepEqual(args, [
      CHANNEL_CONTRACT,
      payerKeypair.publicKey(),
      payeeKeypair.publicKey(),
      5000n,
      2,
    ])
  })

  it('#given a sendTransaction that returns ERROR #when the settlement is recorded #then the failure is logged with tx hash and reason without throwing into the close response', async () => {
    resetRpc()
    rpc.sendStatus = 'ERROR'
    rpc.sendErrorResult = {
      result: () => ({ switch: () => ({ name: 'txInsufficientBalance' }) }),
    }

    const waits: Promise<unknown>[] = []
    const logs: LogLine[] = []
    const callbacks: string[] = []
    const app = makeApp({
      vaultSettlement: { contract: VAULT },
      waitUntil: (p) => { waits.push(p) },
      logs,
      onCallbackError: (_err, cbName) => { callbacks.push(cbName) },
    })

    await capturedCommit!({ payload: { amount: '5000', signature: 'ff'.repeat(32) }, source: payerKeypair.publicKey() })

    const res = await app.request(deleteClose())
    assert.equal(res.status, 200)
    const body = (await res.json()) as { closeTxHash: string | null }
    assert.equal(body.closeTxHash, 'mock-close-tx-hash', 'close response is unaffected by the vault failure')

    assert.equal(waits.length, 1)
    await waits[0]

    const errorLine = logs.find(
      (l) => l.level === 'error' && l.message.includes('failed to record session_settled'),
    )
    assert.ok(errorLine, `expected an error log, got ${JSON.stringify(logs)}`)
    assert.match(String(errorLine.fields?.txHash), /^[0-9a-f]{64}$/, 'failure must carry the tx hash')
    assert.match(String(errorLine.fields?.reason), /txInsufficientBalance/, 'failure must carry the reason')
    assert.equal(errorLine.fields?.channelId, CHANNEL_CONTRACT)

    assert.deepEqual(callbacks, ['vaultSettlement'], 'failure must be reported through onCallbackError')
  })

  it('#given a settlement transaction that fails on-chain #when confirmation returns FAILED #then the failure is logged with the tx hash and reason', async () => {
    resetRpc()
    rpc.txStatus = 'FAILED'

    const waits: Promise<unknown>[] = []
    const logs: LogLine[] = []
    const app = makeApp({
      vaultSettlement: { contract: VAULT },
      waitUntil: (p) => { waits.push(p) },
      logs,
    })

    await capturedCommit!({ payload: { amount: '5000', signature: 'ff'.repeat(32) }, source: payerKeypair.publicKey() })

    const res = await app.request(deleteClose())
    assert.equal(res.status, 200)

    assert.equal(waits.length, 1)
    await waits[0]

    const errorLine = logs.find(
      (l) => l.level === 'error' && l.message.includes('failed to record session_settled'),
    )
    assert.ok(errorLine, `expected an error log, got ${JSON.stringify(logs)}`)
    assert.match(String(errorLine.fields?.txHash), /^[0-9a-f]{64}$/)
    assert.equal(errorLine.fields?.reason, 'transaction failed on-chain')
  })

  it('#given no waitUntil #when a session closes cleanly #then settlement still runs as a background promise', async () => {
    resetRpc()
    const app = makeApp({ vaultSettlement: { contract: VAULT } })

    await capturedCommit!({ payload: { amount: '5000', signature: 'ff'.repeat(32) }, source: payerKeypair.publicKey() })

    const res = await app.request(deleteClose())
    assert.equal(res.status, 200)
    const body = (await res.json()) as { closeTxHash: string | null }
    assert.equal(body.closeTxHash, 'mock-close-tx-hash')

    // No waitUntil handle — poll for the background settlement to complete.
    const deadline = Date.now() + 2000
    while (rpc.sentTx === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.ok(rpc.sentTx, 'background settlement should still have sent the transaction')
  })
})
