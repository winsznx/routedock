/**
 * mpp-session on-chain channel state check (issue #715).
 *
 * Unlike the other session tests, this file runs the real mppx server and the
 * real `@stellar/mpp` channel verifier, so the 402s below come from the same
 * code that runs in production. Only the network edges are replaced:
 *
 * - `getChannelState` (five RPC simulations in the real module) is mocked to
 *   return `channelState`, which each test sets.
 * - `rpc.Server.prototype.getAccount` / `simulateTransaction` are patched so
 *   `prepare_commitment` returns the i128 amount's XDR as the commitment
 *   bytes. Vouchers are signed over those bytes with the commitment key.
 * - `close` records its arguments instead of broadcasting.
 *
 * Nothing here opens a socket other than the local Express/Fastify listeners.
 */

import { mock, describe, it, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Hono } from 'hono'
import express from 'express'
import Fastify from 'fastify'
import { Account, Keypair, Operation, nativeToScVal, rpc, xdr, type Transaction } from '@stellar/stellar-sdk'
import { Challenge, Credential } from 'mppx'
import type { RouteDockManifest } from '../../types.js'

const payeeKeypair = Keypair.random()
const commitKeypair = Keypair.random()

const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const CHANNEL_CONTRACT = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'
const CLOSED_KEY = `stellar:channel:closed:${CHANNEL_CONTRACT}`

interface MockChannelState {
  balance: bigint
  refundWaitingPeriod: number
  token: string
  from: string
  to: string
  closeEffectiveAtLedger: number | null
  currentLedger: number
}

function openChannelState(balance: bigint): MockChannelState {
  return {
    balance,
    refundWaitingPeriod: 17280,
    token: ASSET_CONTRACT,
    from: Keypair.random().publicKey(),
    to: payeeKeypair.publicKey(),
    closeEffectiveAtLedger: null,
    currentLedger: 1000,
  }
}

let channelState: MockChannelState = openChannelState(1_000_000n)
let stateReads = 0
let closeCalls: Array<{ amount: bigint; signature: Uint8Array }> = []

const channelServerUrl = import.meta.resolve('@stellar/mpp/channel/server')
mock.module(new URL('./State.js', channelServerUrl).href, {
  namedExports: {
    getChannelState: async () => {
      stateReads++
      return channelState
    },
  },
})

const actualChannelServer = await import('@stellar/mpp/channel/server')
mock.module('@stellar/mpp/channel/server', {
  namedExports: {
    ...actualChannelServer,
    close: async (opts: { amount: bigint; signature: Uint8Array }) => {
      closeCalls.push({ amount: opts.amount, signature: opts.signature })
      return 'mock-close-tx-hash'
    },
  },
})

// prepare_commitment stand-in: the commitment bytes are the XDR of the i128
// amount argument, so a test signs exactly what the verifier reconstructs.
rpc.Server.prototype.getAccount = async function getAccount(address: string) {
  return new Account(address, '1')
}
rpc.Server.prototype.simulateTransaction = async function simulateTransaction(tx) {
  const op = (tx as Transaction).operations[0] as Operation.InvokeHostFunction
  const amountArg = op.func.invokeContract().args()[0]!
  return {
    _parsed: true,
    id: 'sim',
    latestLedger: 1000,
    events: [],
    transactionData: {},
    minResourceFee: '0',
    result: { auth: [], retval: xdr.ScVal.scvBytes(amountArg.toXDR()) },
  } as unknown as rpc.Api.SimulateTransactionResponse
}

function signVoucher(amount: bigint): string {
  const bytes = nativeToScVal(amount, { type: 'i128' }).toXDR()
  return Buffer.from(commitKeypair.sign(bytes)).toString('hex')
}

const { routedockHono } = await import('../hono.js')
const { routedock } = await import('../routedockMiddleware.js')
const { routedockFastify } = await import('../fastify.js')

function manifestFor(network: 'testnet' | 'mainnet'): RouteDockManifest {
  return { ...manifest, network }
}

const manifest: RouteDockManifest = {
  routedock: '1.0',
  name: 'Test Service',
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

const baseOptions = {
  asset: 'USDC',
  assetContract: ASSET_CONTRACT,
  payee: payeeKeypair.publicKey(),
  network: 'testnet' as const,
  payeeSecretKey: payeeKeypair.secret(),
  commitmentPublicKey: commitKeypair.publicKey(),
  manifest,
  modes: ['mpp-session' as const],
  pricing: { 'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT } },
  logger: () => {},
}

/** One provider under test, behind a uniform `fetch`-style client. */
interface Harness {
  request(init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<Response>
  routeCalls(): number
  close(): Promise<void>
}

type HarnessOptions = {
  channelStateCheck?: { enabled: boolean; maxAgeMs?: number }
  onDisputeDetected?: (channelId: string, state: unknown) => void | Promise<void>
  onSessionOpen?: (channelId: string, payer: string | null) => Promise<void>
  onOrphaned?: (channelId: string, info: { reason: string }) => Promise<void>
  network?: 'testnet' | 'mainnet'
}

function sharedStore() {
  const m = new Map<string, unknown>()
  return {
    map: m,
    store: {
      async get(k: string) { return m.get(k) },
      async put(k: string, v: unknown) { m.set(k, v) },
      async delete(k: string) { m.delete(k) },
    },
  }
}

async function honoHarness(extra: HarnessOptions & { sessionStore?: ReturnType<typeof sharedStore>['store'] }): Promise<Harness> {
  let calls = 0
  const app = new Hono()
  app.use('*', routedockHono({ ...baseOptions, ...extra, manifest: manifestFor(extra.network ?? 'testnet') }))
  app.get('/price', (c) => {
    calls++
    return c.json({ price: '42' })
  })
  return {
    request: async (init) => app.request('/price', init),
    routeCalls: () => calls,
    close: async () => {},
  }
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  return `http://127.0.0.1:${port}/price`
}

async function expressHarness(extra: HarnessOptions): Promise<Harness> {
  let calls = 0
  const app = express()
  app.use(express.json())
  app.use(routedock({ ...baseOptions, ...extra }))
  app.get('/price', (_req, res) => {
    calls++
    res.json({ price: '42' })
  })
  app.delete('/price', (_req, res) => { res.end() })
  const server = createServer(app)
  const url = await listen(server)
  return {
    request: (init) => fetch(url, init),
    routeCalls: () => calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function fastifyHarness(extra: HarnessOptions): Promise<Harness> {
  let calls = 0
  const app = Fastify()
  await app.register(routedockFastify({ ...baseOptions, ...extra }))
  app.get('/price', async () => {
    calls++
    return { price: '42' }
  })
  app.delete('/price', async () => ({}))
  await app.listen({ port: 0, host: '127.0.0.1' })
  const { port } = app.server.address() as AddressInfo
  const url = `http://127.0.0.1:${port}/price`
  return {
    request: (init) => fetch(url, init),
    routeCalls: () => calls,
    close: () => app.close(),
  }
}

/** Fetches a fresh challenge and pays it with a voucher for `amount`. */
async function payVoucher(h: Harness, amount: bigint): Promise<Response> {
  const unpaid = await h.request()
  assert.equal(unpaid.status, 402, 'an unpaid request must get a challenge')
  const challenge = Challenge.fromResponse(unpaid)
  const credential = Credential.from({
    challenge,
    payload: { action: 'voucher', amount: amount.toString(), signature: signVoucher(amount) },
  })
  return h.request({ headers: { authorization: Credential.serialize(credential) } })
}

async function deleteClose(h: Harness): Promise<Response> {
  return h.request({
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  })
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
}

const ENABLED = { channelStateCheck: { enabled: true } }

const adapters: Array<[string, (extra: HarnessOptions) => Promise<Harness>]> = [
  ['Hono', honoHarness],
  ['Express', expressHarness],
  ['Fastify', fastifyHarness],
]

const open: Harness[] = []
async function make(factory: (extra: HarnessOptions) => Promise<Harness>, extra: HarnessOptions): Promise<Harness> {
  const h = await factory(extra)
  open.push(h)
  return h
}

after(async () => {
  await Promise.all(open.map((h) => h.close()))
})

beforeEach(() => {
  channelState = openChannelState(1_000_000n)
  stateReads = 0
  closeCalls = []
})

for (const [name, factory] of adapters) {
  describe(`${name} mpp-session channel state check`, () => {
    it('serves a voucher within the channel balance', async () => {
      // #given a channel holding 1,000,000 stroops and the check enabled
      const h = await make(factory, ENABLED)

      // #when a voucher for 1,000 stroops arrives
      const res = await payVoucher(h, 1000n)

      // #then it is verified against chain state and served
      assert.equal(res.status, 200)
      assert.equal(h.routeCalls(), 1)
      assert.ok(stateReads > 0, 'getChannelState must be consulted')
    })

    it('rejects a voucher above the channel balance with 402 and never runs the route', async () => {
      // #given a channel holding only 500 stroops
      channelState = openChannelState(500n)
      const h = await make(factory, ENABLED)

      // #when the agent signs a 1,000 stroop voucher against it
      const res = await payVoucher(h, 1000n)

      // #then the voucher is refused and no paid content is served
      assert.equal(res.status, 402)
      assert.equal(h.routeCalls(), 0)
    })

    it('on a dispute, fires onDisputeDetected and closes with the highest verified voucher', async () => {
      // #given a session with one verified 1,000 stroop voucher
      const disputes: Array<{ channelId: string; state: unknown }> = []
      const h = await make(factory, {
        ...ENABLED,
        onDisputeDetected: (channelId, state) => { disputes.push({ channelId, state }) },
      })
      assert.equal((await payVoucher(h, 1000n)).status, 200)

      // #when the payer has called close_start and the next voucher arrives
      channelState = { ...channelState, closeEffectiveAtLedger: 2000 }
      const res = await payVoucher(h, 2000n)
      await settle()

      // #then the user hook fires and the channel is closed at 2,000 stroops,
      // the highest voucher verified (the dispute window is still open)
      assert.equal(res.status, 200)
      assert.equal(disputes.length, 1)
      assert.equal(disputes[0]!.channelId, CHANNEL_CONTRACT)
      assert.equal(closeCalls.length, 1)
      assert.equal(closeCalls[0]!.amount, 2000n)
      assert.equal(Buffer.from(closeCalls[0]!.signature).toString('hex'), signVoucher(2000n))

      // #then a later voucher is rejected because the channel is now closed
      const after = await payVoucher(h, 3000n)
      assert.equal(after.status, 402)
      assert.equal(h.routeCalls(), 2)
    })

    it('flags the session orphaned with reason dispute when the dispute close fails', async () => {
      // #given a session with a verified voucher and a close that will fail
      const orphans: string[] = []
      const h = await make(factory, {
        ...ENABLED,
        onOrphaned: async (_id, info) => { orphans.push(info.reason) },
      })
      assert.equal((await payVoucher(h, 1000n)).status, 200)
      const realPush = closeCalls.push.bind(closeCalls)
      closeCalls.push = () => { throw new Error('rpc down') }

      // #when a dispute is detected past the close-effective ledger
      channelState = { ...channelState, closeEffectiveAtLedger: 900 }
      const res = await payVoucher(h, 2000n)
      await settle()
      closeCalls.push = realPush

      // #then the voucher is refused and the reconciler is told why
      // (Express and Fastify may already have flagged the session when the
      // first request's connection closed; the dispute flag still follows)
      assert.equal(res.status, 402)
      assert.equal(orphans.at(-1), 'dispute')
    })

    it('after a DELETE close, a higher voucher gets 402 and does not reopen the session', async () => {
      // #given a session that was opened and then closed by DELETE
      let opened = 0
      const h = await make(factory, {
        ...ENABLED,
        onSessionOpen: async () => { opened++ },
      })
      assert.equal((await payVoucher(h, 1000n)).status, 200)
      await settle()
      assert.equal(opened, 1)
      const closed = await deleteClose(h)
      assert.equal(closed.status, 200)
      assert.equal(closeCalls.length, 1)

      // #when the agent keeps streaming with a higher cumulative
      const res = await payVoucher(h, 5000n)
      await settle()

      // #then it is rejected, the route stays untouched and no session reopens
      assert.equal(res.status, 402)
      assert.equal(h.routeCalls(), 1)
      assert.equal(opened, 1)
    })
  })
}

describe('Hono mpp-session channel store after close', () => {
  it('writes stellar:channel:closed:<channel> with the close tx and amount', async () => {
    // #given a Hono provider on a shared session store
    const { map, store } = sharedStore()
    const h = await honoHarness({ sessionStore: store })
    assert.equal((await payVoucher(h, 1000n)).status, 200)

    // #when the session is closed by DELETE
    assert.equal((await deleteClose(h)).status, 200)

    // #then mppx's closed marker is in the store
    const marker = map.get(CLOSED_KEY) as { closedAt: string; txHash: string; amount: string } | undefined
    assert.ok(marker, 'closed marker must be written')
    assert.equal(marker.txHash, 'mock-close-tx-hash')
    assert.equal(marker.amount, '1000')
    assert.ok(!Number.isNaN(Date.parse(marker.closedAt)))
  })

  it('rejects a later voucher even with the on-chain check off (testnet default)', async () => {
    // #given a testnet provider with no channelStateCheck option
    const h = await honoHarness({})
    assert.equal((await payVoucher(h, 1000n)).status, 200)
    assert.equal((await deleteClose(h)).status, 200)

    // #when a higher voucher arrives after the close
    const res = await payVoucher(h, 5000n)

    // #then the closed marker alone is enough to refuse it, with no RPC read
    assert.equal(res.status, 402)
    assert.equal(h.routeCalls(), 1)
    assert.equal(stateReads, 0)
  })
})

describe('channelStateCheck defaults and maxAgeMs', () => {
  it('is enabled by default on mainnet', async () => {
    // #given a mainnet provider with no channelStateCheck option
    channelState = openChannelState(500n)
    const h = await honoHarness({ network: 'mainnet' })

    // #when a voucher above the balance arrives
    const res = await payVoucher(h, 1000n)

    // #then the on-chain check ran and refused it
    assert.equal(res.status, 402)
    assert.ok(stateReads > 0)
  })

  it('is disabled by default on testnet', async () => {
    // #given a testnet provider with no channelStateCheck option
    channelState = openChannelState(500n)
    const h = await honoHarness({})

    // #when a voucher above the on-chain balance arrives
    const res = await payVoucher(h, 1000n)

    // #then no RPC read happens and the voucher is served, as before
    assert.equal(res.status, 200)
    assert.equal(stateReads, 0)
  })

  it('can be turned off on mainnet', async () => {
    // #given a mainnet provider that opts out
    const h = await honoHarness({ network: 'mainnet', channelStateCheck: { enabled: false } })

    // #when a voucher arrives
    const res = await payVoucher(h, 1000n)

    // #then no RPC read happens
    assert.equal(res.status, 200)
    assert.equal(stateReads, 0)
  })

  it('reuses a fresh cached read and still enforces the cached balance', async () => {
    // #given a check with a one-minute cache window
    channelState = openChannelState(2500n)
    const h = await honoHarness({ channelStateCheck: { enabled: true, maxAgeMs: 60_000 } })

    // #when three vouchers arrive, the last one above the balance
    const first = await payVoucher(h, 1000n)
    const readsAfterFirst = stateReads
    const second = await payVoucher(h, 2000n)
    const third = await payVoucher(h, 3000n)

    // #then only the first voucher paid for an RPC read, and the cached
    // balance still refused the over-balance voucher
    assert.equal(first.status, 200)
    assert.equal(second.status, 200)
    assert.equal(third.status, 402)
    assert.equal(readsAfterFirst, 1)
    assert.equal(stateReads, 1)
    assert.equal(h.routeCalls(), 2)
  })

  it('reads chain state again once the cache is older than maxAgeMs', async () => {
    // #given a check with a zero-length cache window
    const h = await honoHarness({ channelStateCheck: { enabled: true, maxAgeMs: 0 } })

    // #when two vouchers arrive
    await payVoucher(h, 1000n)
    await payVoucher(h, 2000n)

    // #then each one triggered a fresh read
    assert.equal(stateReads, 2)
  })
})
