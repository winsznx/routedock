/**
 * Express mpp-session: session_settled is recorded on the agent vault after a
 * clean close (issue #555). Mirrors hono-vault-settlement.test.ts — same
 * mocking strategy, same assertions — against the Express handler
 * (MppSessionHandler.ts / routedockMiddleware.ts).
 *
 * The old Express path read `process.env.AGENT_VAULT_CONTRACT` and ignored
 * `sendTransaction` results; the shared `recordSessionSettlement` helper
 * replaces it, and the deprecated env fallback (now also accepting the
 * docs' `AGENT_VAULT_CONTRACT_ID` name) is exercised here too.
 */

import { mock, describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import express from 'express'
import type { Request, Response } from 'express'
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
    stellar: { channel: () => [] },
  },
})

// Capture `commit` so the test can feed in verified vouchers without building
// a full signed credential (same trick as MppSessionHandler-verified-voucher.test.ts).
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

const { routedock } = await import('../routedockMiddleware.js')

// The deprecated env fallback must never fire unless a test asks for it.
delete process.env.AGENT_VAULT_CONTRACT
delete process.env.AGENT_VAULT_CONTRACT_ID

const manifest: RouteDockManifest = {
  routedock: '1.0',
  name: 'Express Vault Settlement Test',
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

/** Boots a real Express server with the mpp-session middleware and returns its URL + the captured `commit`. */
async function makeServer(
  extra: {
    vaultSettlement?: { contract: string; rpcUrl?: string }
    onCallbackError?: (err: unknown, cbName: string) => void
    logs?: LogLine[]
  } = {},
): Promise<{ url: string; commit: Commit; close: () => Promise<void> }> {
  const app = express()
  app.use(
    routedock({
      asset: 'USDC',
      assetContract: ASSET_CONTRACT,
      payee: payeeKeypair.publicKey(),
      network: 'testnet',
      payeeSecretKey: payeeKeypair.secret(),
      commitmentPublicKey: commitKeypair.publicKey(),
      manifest,
      modes: ['mpp-session'],
      pricing: { 'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT } },
      ...(extra.logs
        ? { logger: (level, message, fields) => { extra.logs!.push({ level, message, fields }) } }
        : {}),
      ...(extra.vaultSettlement ? { vaultSettlement: extra.vaultSettlement } : {}),
      ...(extra.onCallbackError ? { onCallbackError: extra.onCallbackError } : {}),
    } as Parameters<typeof routedock>[0]),
  )
  app.get('/price', (_req: Request, res: Response) => {
    res.json({ price: '42' })
  })

  assert.ok(capturedCommit, 'onVerifiedCredential mock should have captured commit during construction')
  const commit = capturedCommit!

  return new Promise((resolve) => {
    const server = createServer(app)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({
        url: `http://127.0.0.1:${port}`,
        commit,
        close: () => new Promise<void>((res) => server.close(() => res())),
      })
    })
  })
}

/** Bounded wait for a condition the settlement flow sets asynchronously. */
async function waitFor(cond: () => boolean, what: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!cond() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.ok(cond(), `timed out waiting for ${what}`)
}

function deleteClose(url: string) {
  return fetch(`${url}/price`, {
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

afterEach(() => {
  delete process.env.AGENT_VAULT_CONTRACT
  delete process.env.AGENT_VAULT_CONTRACT_ID
})

describe('routedock (Express) — vault session settlement on clean close', () => {
  it('#given no vaultSettlement option #when a session closes cleanly #then no vault RPC call is made', async () => {
    resetRpc()
    const { url, commit, close } = await makeServer()
    try {
      await commit({ payload: { amount: '5000', signature: 'ff'.repeat(32) }, source: payerKeypair.publicKey() })

      const res = await deleteClose(url)
      assert.equal(res.status, 200)
      const body = (await res.json()) as { closeTxHash: string | null }
      assert.equal(body.closeTxHash, 'mock-close-tx-hash')

      // Give any stray background settlement a chance to surface before
      // asserting that none was started.
      await new Promise((resolve) => setTimeout(resolve, 50))
      assert.equal(rpc.urls.length, 0, 'no RPC client should have been constructed')
      assert.equal(rpc.getAccountCalls.length, 0)
      assert.equal(rpc.preparedTx, null)
      assert.equal(rpc.sentTx, null)
    } finally {
      await close()
    }
  })

  it('#given the vaultSettlement option #when a session closes cleanly #then record_session_settlement is built with the session\'s channel, payer, payee, amount and voucher count', async () => {
    resetRpc()
    const { url, commit, close } = await makeServer({ vaultSettlement: { contract: VAULT } })
    try {
      // Two verified vouchers — the record must carry voucher count 2.
      await commit({ payload: { amount: '3000', signature: 'aa'.repeat(32) }, source: payerKeypair.publicKey() })
      await commit({ payload: { amount: '5000', signature: 'ff'.repeat(32) }, source: payerKeypair.publicKey() })

      const res = await deleteClose(url)
      assert.equal(res.status, 200)
      const body = (await res.json()) as { closeTxHash: string | null }
      assert.equal(body.closeTxHash, 'mock-close-tx-hash')

      await waitFor(() => rpc.sentTx !== null, 'the settlement transaction to be sent')

      assert.deepEqual(rpc.urls, ['https://soroban-testnet.stellar.org'], 'default testnet RPC endpoint')
      assert.deepEqual(rpc.getAccountCalls, [payeeKeypair.publicKey()], 'tx sourced from the payee')
      assert.equal(rpc.sentTx, rpc.preparedTx, 'the prepared transaction should be the one sent')

      const { fn, args } = hostCall(rpc.preparedTx!)
      assert.equal(fn, 'record_session_settlement')
      // (channel_id, payer, payee, cumulative_amount, voucher_count)
      assert.deepEqual(args, [
        CHANNEL_CONTRACT,
        payerKeypair.publicKey(),
        payeeKeypair.publicKey(),
        5000n,
        2,
      ])
    } finally {
      await close()
    }
  })

  it('#given a sendTransaction that returns ERROR #when the settlement is recorded #then the failure is logged with tx hash and reason without breaking the close response', async () => {
    resetRpc()
    rpc.sendStatus = 'ERROR'
    rpc.sendErrorResult = {
      result: () => ({ switch: () => ({ name: 'txInsufficientBalance' }) }),
    }

    const logs: LogLine[] = []
    const callbacks: string[] = []
    const { url, commit, close } = await makeServer({
      vaultSettlement: { contract: VAULT },
      logs,
      onCallbackError: (_err, cbName) => { callbacks.push(cbName) },
    })
    try {
      await commit({ payload: { amount: '5000', signature: 'ff'.repeat(32) }, source: payerKeypair.publicKey() })

      const res = await deleteClose(url)
      assert.equal(res.status, 200)
      const body = (await res.json()) as { closeTxHash: string | null }
      assert.equal(body.closeTxHash, 'mock-close-tx-hash', 'close response is unaffected by the vault failure')

      await waitFor(
        () => logs.some((l) => l.level === 'error' && l.message.includes('failed to record session_settled')),
        'the failure to be logged',
      )

      const errorLine = logs.find(
        (l) => l.level === 'error' && l.message.includes('failed to record session_settled'),
      )!
      assert.match(String(errorLine.fields?.txHash), /^[0-9a-f]{64}$/, 'failure must carry the tx hash')
      assert.match(String(errorLine.fields?.reason), /txInsufficientBalance/, 'failure must carry the reason')
      assert.equal(errorLine.fields?.channelId, CHANNEL_CONTRACT)

      assert.deepEqual(callbacks, ['vaultSettlement'], 'failure must be reported through onCallbackError')
    } finally {
      await close()
    }
  })

  it('#given a settlement transaction that fails on-chain #when confirmation returns FAILED #then the failure is logged with the tx hash and reason', async () => {
    resetRpc()
    rpc.txStatus = 'FAILED'

    const logs: LogLine[] = []
    const { url, commit, close } = await makeServer({ vaultSettlement: { contract: VAULT }, logs })
    try {
      await commit({ payload: { amount: '5000', signature: 'ff'.repeat(32) }, source: payerKeypair.publicKey() })

      const res = await deleteClose(url)
      assert.equal(res.status, 200)

      await waitFor(
        () => logs.some((l) => l.level === 'error' && l.message.includes('failed to record session_settled')),
        'the failure to be logged',
      )

      const errorLine = logs.find(
        (l) => l.level === 'error' && l.message.includes('failed to record session_settled'),
      )!
      assert.match(String(errorLine.fields?.txHash), /^[0-9a-f]{64}$/)
      assert.equal(errorLine.fields?.reason, 'transaction failed on-chain')
    } finally {
      await close()
    }
  })

  it('#given the deprecated AGENT_VAULT_CONTRACT_ID env var #when the option is unset #then settlement still happens with a deprecation warning', async () => {
    resetRpc()
    process.env.AGENT_VAULT_CONTRACT_ID = VAULT

    const logs: LogLine[] = []
    const { url, commit, close } = await makeServer({ logs })
    try {
      await commit({ payload: { amount: '5000', signature: 'ff'.repeat(32) }, source: payerKeypair.publicKey() })

      const res = await deleteClose(url)
      assert.equal(res.status, 200)

      await waitFor(() => rpc.sentTx !== null, 'the env-configured settlement to be sent')

      const { fn, args } = hostCall(rpc.preparedTx!)
      assert.equal(fn, 'record_session_settlement')
      assert.equal(args[0], CHANNEL_CONTRACT)

      const warning = logs.find(
        (l) => l.level === 'warn' && l.message.includes('deprecated'),
      )
      assert.ok(warning, `expected a deprecation warning, got ${JSON.stringify(logs)}`)
    } finally {
      await close()
    }
  })
})
