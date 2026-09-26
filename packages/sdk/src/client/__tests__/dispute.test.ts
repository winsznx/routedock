/**
 * Behavioral unit tests for MppSessionClient dispute resolution.
 *
 * These tests drive requestRefund(), settleWithLatestVoucher(), and
 * getDisputeStatus() against a mocked @stellar/stellar-sdk RPC layer so the
 * methods' real control flow — simulation, send, response mapping, and error
 * wrapping — is exercised without touching the network.
 *
 * Run with: pnpm --filter @routedock/routedock test
 * (requires --experimental-test-module-mocks, set in the package test script)
 */

import assert from 'node:assert/strict'
import { before, after, beforeEach, describe, it, mock } from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import { MppSessionClient } from '../MppSessionClient.js'
import type { RouteDockManifest } from '../../types.js'
import {
  RouteDockDisputeError,
  RouteDockChannelStateError,
  RouteDockRefundWindowError,
} from '../../types.js'

const agentKeypair = Keypair.random()
const commitmentKeypair = Keypair.random()
const payeeKeypair = Keypair.random()

const CHANNEL_CONTRACT = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'
const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const SESSION_URL = 'https://provider.test/stream/orderbook'

function buildManifest(): RouteDockManifest {
  return {
    routedock: '1.0',
    name: 'Dispute Test Provider',
    description: 'Provider exercised by dispute resolution unit tests',
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
    endpoints: { stream: { method: 'GET', path: '/stream/orderbook' } },
    tags: ['orderbook', 'stellar', 'test'],
  }
}

// ── Mock Stellar RPC ──────────────────────────────────────────────────────────
// A configurable fake of the parts of @stellar/stellar-sdk the dispute methods
// use. Each test sets `rpc` to script getAccount/simulate/send behaviour; the
// dynamic `import('@stellar/stellar-sdk')` inside the SUT resolves to this mock.

interface RpcScript {
  getAccount?: (publicKey: string) => unknown
  simulateTransaction?: (tx: unknown) => unknown
  prepareTransaction?: (tx: unknown) => unknown
  sendTransaction?: (tx: unknown) => unknown
  getTransaction?: (hash: string) => unknown
  isSimulationError?: (result: unknown) => boolean
}

const DEFAULT_ACCOUNT = {
  accountId: () => agentKeypair.publicKey(),
  sequenceNumber: () => '1',
  incrementSequenceNumber: () => undefined,
}

let rpc: RpcScript = {}

function buildFakeSdk() {
  class FakeServer {
    constructor(_url: string) {}
    async getAccount(publicKey: string) {
      return (rpc.getAccount ?? (() => DEFAULT_ACCOUNT))(publicKey)
    }
    async simulateTransaction(tx: unknown) {
      return (rpc.simulateTransaction ?? (() => ({})))(tx)
    }
    async prepareTransaction(tx: unknown) {
      return (rpc.prepareTransaction ?? (async () => tx))(tx)
    }
    async sendTransaction(tx: unknown) {
      return (rpc.sendTransaction ?? (() => ({ hash: 'DEFAULT_HASH' })))(tx)
    }
    async getTransaction(hash: string) {
      return (rpc.getTransaction ?? (() => ({ status: 'SUCCESS' })))(hash)
    }
  }

  class FakeContract {
    constructor(_address: string) {}
    call(fn: string, ...args: unknown[]) {
      return { __op: fn, args }
    }
  }

  class FakeTransactionBuilder {
    constructor(_account: unknown, _opts: unknown) {}
    addOperation() {
      return this
    }
    setTimeout() {
      return this
    }
    build() {
      return { sign: (_kp: unknown) => undefined }
    }
  }

  return {
    rpc: {
      Server: FakeServer,
      Api: {
        isSimulationError: (result: unknown) =>
          (rpc.isSimulationError ?? (() => false))(result),
      },
    },
    Contract: FakeContract,
    TransactionBuilder: FakeTransactionBuilder,
    BASE_FEE: '100',
    nativeToScVal: (value: unknown) => ({ __scval: value }),
  }
}

function openHandle() {
  // MppSessionClient (and its @stellar/mpp graph) is imported statically above,
  // binding to the real SDK before the mock is registered. Only the dispute
  // methods' call-time dynamic stellar-sdk import resolves to the mock.
  const client = new MppSessionClient(agentKeypair, 'testnet')
  return client.openSession(SESSION_URL, buildManifest(), commitmentKeypair.secret())
}

before(() => {
  mock.module('@stellar/stellar-sdk', { namedExports: buildFakeSdk() })
})

after(() => {
  mock.restoreAll()
})

beforeEach(() => {
  rpc = {}
})

// ── requestRefund() ────────────────────────────────────────────────────────────

describe('requestRefund()', () => {
  it('returns the transaction hash when the refund is submitted and confirmed on-chain', async () => {
    rpc.sendTransaction = () => ({ hash: 'REFUND_TX_HASH' })
    rpc.getTransaction = () => ({ status: 'SUCCESS' })
    const handle = await openHandle()
    const hash = await handle.requestRefund()
    assert.equal(hash, 'REFUND_TX_HASH')
  })

  it('throws RouteDockDisputeError when sendTransaction returns TRY_AGAIN_LATER', async () => {
    rpc.sendTransaction = () => ({ status: 'TRY_AGAIN_LATER', hash: 'TRY_AGAIN_HASH' })
    const handle = await openHandle()
    await assert.rejects(
      () => handle.requestRefund(),
      (err: unknown) =>
        err instanceof RouteDockDisputeError &&
        /TRY_AGAIN_LATER/i.test((err as Error).message),
    )
  })

  it('throws RouteDockDisputeError when getTransaction returns FAILED', async () => {
    rpc.sendTransaction = () => ({ hash: 'FAILED_TX_HASH' })
    rpc.getTransaction = () => ({ status: 'FAILED', resultXdr: 'AAAA...' })
    const handle = await openHandle()
    await assert.rejects(
      () => handle.requestRefund(),
      (err: unknown) =>
        err instanceof RouteDockDisputeError &&
        /FAILED/i.test((err as Error).message),
    )
  })

  it('resolves with the hash when getTransaction returns NOT_FOUND then SUCCESS', async () => {
    let pollCount = 0
    rpc.sendTransaction = () => ({ hash: 'POLL_TX_HASH' })
    rpc.getTransaction = () => {
      pollCount++
      return pollCount < 3 ? { status: 'NOT_FOUND' } : { status: 'SUCCESS' }
    }
    const handle = await openHandle()
    const hash = await handle.requestRefund({ intervalMs: 10, timeoutMs: 500 })
    assert.equal(hash, 'POLL_TX_HASH')
    assert.ok(pollCount >= 3)
  })

  it('throws RouteDockDisputeError with the hash when getTransaction keeps returning NOT_FOUND past timeout', async () => {
    rpc.sendTransaction = () => ({ hash: 'TIMEOUT_TX_HASH' })
    rpc.getTransaction = () => ({ status: 'NOT_FOUND' })
    const handle = await openHandle()
    await assert.rejects(
      () => handle.requestRefund({ timeoutMs: 25, intervalMs: 5 }),
      (err: unknown) =>
        err instanceof RouteDockDisputeError &&
        (err as Error).message.includes('TIMEOUT_TX_HASH') &&
        /timed out/i.test((err as Error).message),
    )
  })

  it('throws RouteDockDisputeError when there is no open channel (simulation fails)', async () => {
    rpc.isSimulationError = () => true
    rpc.simulateTransaction = () => ({ error: 'channel not open' })
    const handle = await openHandle()
    await assert.rejects(
      () => handle.requestRefund(),
      (err: unknown) => err instanceof RouteDockDisputeError,
    )
  })

  it('throws RouteDockDisputeError when the transaction is not sent', async () => {
    rpc.sendTransaction = () => ({}) // no hash
    const handle = await openHandle()
    await assert.rejects(
      () => handle.requestRefund(),
      (err: unknown) =>
        err instanceof RouteDockDisputeError &&
        /not sent/i.test((err as Error).message),
    )
  })

  it('wraps unexpected RPC failures as RouteDockDisputeError', async () => {
    rpc.getAccount = () => {
      throw new Error('horizon unreachable')
    }
    const handle = await openHandle()
    await assert.rejects(
      () => handle.requestRefund(),
      (err: unknown) => err instanceof RouteDockDisputeError,
    )
  })
})

// ── settleWithLatestVoucher() ──────────────────────────────────────────────────

describe('settleWithLatestVoucher()', () => {
  it('returns the settlement transaction hash on success', async () => {
    rpc.simulateTransaction = () => ({
      result: { retval: { bytes: () => Buffer.from([1, 2, 3, 4]) } },
    })
    rpc.sendTransaction = () => ({ hash: 'SETTLE_TX_HASH' })
    rpc.getTransaction = () => ({ status: 'SUCCESS' })
    const handle = await openHandle()
    const hash = await handle.settleWithLatestVoucher()
    assert.equal(hash, 'SETTLE_TX_HASH')
  })

  it('throws RouteDockDisputeError when sendTransaction returns TRY_AGAIN_LATER', async () => {
    rpc.simulateTransaction = () => ({
      result: { retval: { bytes: () => Buffer.from([1, 2, 3, 4]) } },
    })
    rpc.sendTransaction = () => ({ status: 'TRY_AGAIN_LATER', hash: 'TRY_AGAIN_HASH' })
    const handle = await openHandle()
    await assert.rejects(
      () => handle.settleWithLatestVoucher(),
      (err: unknown) =>
        err instanceof RouteDockDisputeError &&
        /TRY_AGAIN_LATER/i.test((err as Error).message),
    )
  })

  it('throws RouteDockDisputeError when getTransaction returns FAILED', async () => {
    rpc.simulateTransaction = () => ({
      result: { retval: { bytes: () => Buffer.from([1, 2, 3, 4]) } },
    })
    rpc.sendTransaction = () => ({ hash: 'SETTLE_FAILED_HASH' })
    rpc.getTransaction = () => ({ status: 'FAILED', resultXdr: 'AAAA...' })
    const handle = await openHandle()
    await assert.rejects(
      () => handle.settleWithLatestVoucher(),
      (err: unknown) =>
        err instanceof RouteDockDisputeError &&
        /FAILED/i.test((err as Error).message),
    )
  })

  it('resolves with the hash when getTransaction returns NOT_FOUND then SUCCESS', async () => {
    let pollCount = 0
    rpc.simulateTransaction = () => ({
      result: { retval: { bytes: () => Buffer.from([1, 2, 3, 4]) } },
    })
    rpc.sendTransaction = () => ({ hash: 'SETTLE_POLL_HASH' })
    rpc.getTransaction = () => {
      pollCount++
      return pollCount < 3 ? { status: 'NOT_FOUND' } : { status: 'SUCCESS' }
    }
    const handle = await openHandle()
    const hash = await handle.settleWithLatestVoucher({ intervalMs: 10, timeoutMs: 500 })
    assert.equal(hash, 'SETTLE_POLL_HASH')
    assert.ok(pollCount >= 3)
  })

  it('throws RouteDockDisputeError with the hash when getTransaction keeps returning NOT_FOUND past timeout', async () => {
    rpc.simulateTransaction = () => ({
      result: { retval: { bytes: () => Buffer.from([1, 2, 3, 4]) } },
    })
    rpc.sendTransaction = () => ({ hash: 'SETTLE_TIMEOUT_HASH' })
    rpc.getTransaction = () => ({ status: 'NOT_FOUND' })
    const handle = await openHandle()
    await assert.rejects(
      () => handle.settleWithLatestVoucher({ timeoutMs: 25, intervalMs: 5 }),
      (err: unknown) =>
        err instanceof RouteDockDisputeError &&
        (err as Error).message.includes('SETTLE_TIMEOUT_HASH') &&
        /timed out/i.test((err as Error).message),
    )
  })

  it('throws RouteDockDisputeError when prepare_commitment returns no bytes', async () => {
    rpc.simulateTransaction = () => ({ result: { retval: { bytes: () => undefined } } })
    const handle = await openHandle()
    await assert.rejects(
      () => handle.settleWithLatestVoucher(),
      (err: unknown) =>
        err instanceof RouteDockDisputeError &&
        /no bytes/i.test((err as Error).message),
    )
  })

  it('throws RouteDockDisputeError when the commitment simulation fails', async () => {
    rpc.isSimulationError = () => true
    rpc.simulateTransaction = () => ({ error: 'sim failed' })
    const handle = await openHandle()
    await assert.rejects(
      () => handle.settleWithLatestVoucher(),
      (err: unknown) => err instanceof RouteDockDisputeError,
    )
  })
})

// ── getDisputeStatus() ─────────────────────────────────────────────────────────

describe('getDisputeStatus()', () => {
  const cases: Array<[string, 'open' | 'in-refund-window' | 'refundable' | 'settled']> = [
    ['open', 'open'],
    ['in_refund_window', 'in-refund-window'],
    ['refundable', 'refundable'],
    ['settled', 'settled'],
  ]

  for (const [contractStatus, expected] of cases) {
    it(`maps contract status "${contractStatus}" to "${expected}"`, async () => {
      rpc.simulateTransaction = () => ({ result: { retval: { status: contractStatus } } })
      const handle = await openHandle()
      const status = await handle.getDisputeStatus()
      assert.equal(status, expected)
    })
  }

  it('defaults to "open" for an unrecognized contract status', async () => {
    rpc.simulateTransaction = () => ({ result: { retval: { status: 'something_new' } } })
    const handle = await openHandle()
    const status = await handle.getDisputeStatus()
    assert.equal(status, 'open')
  })

  it('throws RouteDockChannelStateError when the state query simulation fails', async () => {
    rpc.isSimulationError = () => true
    rpc.simulateTransaction = () => ({ error: 'state query failed' })
    const handle = await openHandle()
    await assert.rejects(
      () => handle.getDisputeStatus(),
      (err: unknown) => err instanceof RouteDockChannelStateError,
    )
  })

  it('throws RouteDockChannelStateError when no channel state is returned', async () => {
    rpc.simulateTransaction = () => ({ result: { retval: undefined } })
    const handle = await openHandle()
    await assert.rejects(
      () => handle.getDisputeStatus(),
      (err: unknown) =>
        err instanceof RouteDockChannelStateError &&
        /no channel state/i.test((err as Error).message),
    )
  })
})

// ── Error type contract ────────────────────────────────────────────────────────

describe('dispute error types', () => {
  it('exports the dispute error classes with matching names', () => {
    assert.equal(new RouteDockDisputeError('x').name, 'RouteDockDisputeError')
    assert.equal(new RouteDockChannelStateError('x').name, 'RouteDockChannelStateError')
    assert.equal(new RouteDockRefundWindowError('x').name, 'RouteDockRefundWindowError')
  })

  it('dispute errors are instances of Error', () => {
    assert.ok(new RouteDockDisputeError('x') instanceof Error)
  })
})
