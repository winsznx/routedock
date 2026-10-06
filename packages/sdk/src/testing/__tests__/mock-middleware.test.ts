import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { StrKey } from '@stellar/stellar-sdk'
import {
  createMockRoutedockMiddleware,
  runMockSettlement,
  type MockSettlementRecord,
} from '../createMockRoutedockMiddleware.js'
import type { RouteDockMiddlewareOptions } from '../../provider/routedockMiddleware.js'

const PAYER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const ALL_MODES = ['x402', 'mpp-charge', 'mpp-session', 'mpp-session-ws'] as const

/** Minimal Express-shaped fakes — the middleware only uses these members. */
function fakeRes() {
  const calls = { status: undefined as number | undefined, body: undefined as unknown }
  const res = {
    status(code: number) {
      calls.status = code
      return res
    },
    json(body: unknown) {
      calls.body = body
      return res
    },
  }
  return { res, calls }
}

/** Run the handler and resolve once it has either called next() or sent a response. */
function drive(handler: ReturnType<typeof createMockRoutedockMiddleware>, req: Record<string, unknown> = {}) {
  return new Promise<{ nexted: boolean; err: unknown; res: ReturnType<typeof fakeRes>['calls']; req: Record<string, unknown> }>((resolve) => {
    const { res, calls } = fakeRes()
    const origJson = res.json.bind(res)
    res.json = (body: unknown) => {
      const r = origJson(body)
      resolve({ nexted: false, err: undefined, res: calls, req })
      return r
    }
    handler(req as never, res as never, (err?: unknown) => {
      resolve({ nexted: true, err, res: calls, req })
    })
  })
}

describe('runMockSettlement', () => {
  it('x402 auto-pass invokes onSettled with default synthetic data', async () => {
    const settled: Array<[string, string, string]> = []
    const record = await runMockSettlement({
      mode: 'x402',
      onSettled: (txHash, amount, mode) => { settled.push([txHash, amount, mode]) },
    })
    assert.equal(settled.length, 1)
    const [first] = settled
    assert.deepEqual([first?.[1], first?.[2]], ['0.001', 'x402'])
    assert.equal(record?.mode, 'x402')
    assert.equal(record?.amount, '0.001')
  })

  it('mpp-charge auto-pass honors a custom synthetic amount', async () => {
    let seen = ''
    await runMockSettlement({
      mode: 'mpp-charge',
      synthetic: { amount: '0.0008', txHash: 'abc' },
      onSettled: (_t, amount) => { seen = amount },
    })
    assert.equal(seen, '0.0008')
  })

  it('mpp-session auto-pass drives open, vouchers, and a cumulative settle', async () => {
    const events: string[] = []
    const vouchers: Array<[number, string]> = []
    const record = await runMockSettlement({
      mode: 'mpp-session',
      synthetic: { rate: '0.0001', voucherCount: 3, channelId: 'CHAN' },
      onSessionOpen: (id) => { events.push(`open:${id}`) },
      onVoucher: (_id, i, cum) => { vouchers.push([i, cum]) },
      onSettled: (_t, total, mode) => { events.push(`settled:${total}:${mode}`) },
    })
    assert.deepEqual(events, ['open:CHAN', 'settled:0.0003000:mpp-session'])
    // 1-based index, monotonically increasing cumulative — mirrors the real handler.
    assert.deepEqual(vouchers, [[1, '0.0001000'], [2, '0.0002000'], [3, '0.0003000']])
    assert.equal(record?.vouchers?.length, 3)
  })

  it('auto-fail invokes no callbacks and returns null', async () => {
    let called = false
    const record = await runMockSettlement({
      payment: 'auto-fail',
      onSettled: () => { called = true },
    })
    assert.equal(called, false)
    assert.equal(record, null)
  })

  it('accepts production-typed callbacks with no cast (type guard)', async () => {
    const prod: Pick<RouteDockMiddlewareOptions, 'onSettled' | 'onSessionOpen' | 'onVoucher'> = {
      onSettled: async (_txHash, _amount, _mode, _payer) => {},
      onSessionOpen: async (_channelId, _payer) => {},
      onVoucher: async (_channelId, _index, _cumulative, _signature) => {},
    }

    const record = await runMockSettlement({ mode: 'mpp-session', ...prod })
    assert.equal(record?.mode, 'mpp-session')

    const handler = createMockRoutedockMiddleware({ mode: 'x402', payment: 'auto-pass', ...prod })
    assert.equal(typeof handler, 'function')
  })

  it('passes a valid Stellar payer by default to every mode', async () => {
    for (const mode of ALL_MODES) {
      const settled: Array<string | null | undefined> = []
      const opened: Array<string | null | undefined> = []
      await runMockSettlement({
        mode,
        onSettled: (_t, _a, _m, payer) => { settled.push(payer) },
        onSessionOpen: (_c, payer) => { opened.push(payer) },
      })

      assert.equal(settled.length, 1)
      assert.equal(typeof settled[0], 'string')
      assert.ok(StrKey.isValidEd25519PublicKey(settled[0] as string))

      if (mode === 'mpp-session' || mode === 'mpp-session-ws') {
        assert.equal(opened.length, 1)
        assert.strictEqual(opened[0], settled[0])
      } else {
        assert.equal(opened.length, 0)
      }
    }
  })

  it('passes an explicit payer through to onSettled and onSessionOpen', async () => {
    let settledPayer: string | null | undefined
    let openedPayer: string | null | undefined
    await runMockSettlement({
      mode: 'mpp-session',
      synthetic: { payer: PAYER },
      onSettled: (_t, _a, _m, payer) => { settledPayer = payer },
      onSessionOpen: (_c, payer) => { openedPayer = payer },
    })
    assert.strictEqual(settledPayer, PAYER)
    assert.strictEqual(openedPayer, PAYER)
  })

  it('passes an explicit null payer through (address unavailable)', async () => {
    let settledPayer: string | null | undefined
    let openedPayer: string | null | undefined
    await runMockSettlement({
      mode: 'mpp-session',
      synthetic: { payer: null },
      onSettled: (_t, _a, _m, payer) => { settledPayer = payer },
      onSessionOpen: (_c, payer) => { openedPayer = payer },
    })
    assert.strictEqual(settledPayer, null)
    assert.strictEqual(openedPayer, null)
  })

  it('drives mpp-session-ws as a full session and reports the transport as mode', async () => {
    const opened: string[] = []
    const vouchers: Array<[number, string]> = []
    const settled: Array<[string, string]> = []

    const record = await runMockSettlement({
      mode: 'mpp-session-ws',
      synthetic: { rate: '0.0001', voucherCount: 3, channelId: 'CHAN' },
      onSessionOpen: (id) => { opened.push(id) },
      onVoucher: (_id, i, cum) => { vouchers.push([i, cum]) },
      onSettled: (_t, total, mode) => { settled.push([total, mode]) },
    })

    assert.deepEqual(opened, ['CHAN'])
    assert.deepEqual(vouchers, [[1, '0.0001000'], [2, '0.0002000'], [3, '0.0003000']])
    assert.deepEqual(settled, [['0.0003000', 'mpp-session-ws']])
    assert.equal(record?.mode, 'mpp-session-ws')
    assert.equal(record?.channelId, 'CHAN')
    assert.equal(record?.vouchers?.length, 3)
  })

  it('still reports mpp-session for the SSE transport', async () => {
    const settled: string[] = []
    await runMockSettlement({
      mode: 'mpp-session',
      onSettled: (_t, _a, mode) => { settled.push(mode) },
    })
    assert.deepEqual(settled, ['mpp-session'])
  })
})

describe('createMockRoutedockMiddleware', () => {
  it('auto-pass invokes onSettled then calls the route handler (next)', async () => {
    let settledMode = ''
    const handler = createMockRoutedockMiddleware({
      mode: 'x402',
      payment: 'auto-pass',
      onSettled: (_t, _a, mode) => { settledMode = mode },
    })
    const out = await drive(handler)
    assert.equal(out.nexted, true)
    assert.equal(out.err, undefined)
    assert.equal(settledMode, 'x402')
  })

  it('auto-pass attaches the synthetic settlement to req.routedock', async () => {
    const handler = createMockRoutedockMiddleware({ mode: 'mpp-charge', payment: 'auto-pass' })
    const out = await drive(handler)
    const record = out.req.routedock as MockSettlementRecord
    assert.equal(record.mode, 'mpp-charge')
    assert.equal(record.amount, '0.001')
    assert.ok(record.txHash)
  })

  it('auto-fail responds 402 and never calls next or onSettled', async () => {
    let called = false
    const handler = createMockRoutedockMiddleware({
      payment: 'auto-fail',
      onSettled: () => { called = true },
    })
    const out = await drive(handler)
    assert.equal(out.nexted, false)
    assert.equal(out.res.status, 402)
    assert.equal(called, false)
  })

  it('auto-fail honors a custom failStatus', async () => {
    const handler = createMockRoutedockMiddleware({ payment: 'auto-fail', failStatus: 403 })
    const out = await drive(handler)
    assert.equal(out.res.status, 403)
  })

  it('callback errors propagate to next(err)', async () => {
    const handler = createMockRoutedockMiddleware({
      payment: 'auto-pass',
      onSettled: () => { throw new Error('supabase down') },
    })
    const out = await drive(handler)
    assert.equal(out.nexted, true)
    assert.ok(out.err instanceof Error)
    assert.match((out.err as Error).message, /supabase down/)
  })
})
