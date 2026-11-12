import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { SeenTxStore, SettlementRecord } from '../SeenTxStore.js'
import {
  createNanoExact,
  nanoOrderCommitment,
  xnoToRaw,
  RAW_PER_XNO,
  NANO_MAINNET,
  type NanoExactOptions,
} from '../nano/exact.js'

const PAY_TO = 'nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3'
const OTHER = 'nano_1111111111111111111111111111111111111111111111111111hifc8npp'
const NODE = 'https://node.example/rpc'
const PRICE = xnoToRaw('0.05')
const ORDER = '00112233445566778899aabbccddeeff'
const OTHER_ORDER = 'ffeeddccbbaa99887766554433221100'
// SHA-256("xno-binding/v1/rep|" + ORDER + "|" + PAY_TO + "|" + PRICE) as an account (Python hashlib).
const COMMITMENT = 'nano_31mxuwexkyg3ft7qi8k6ttf7em44twqs8pz87epk5wdokr8izfojmk6rzets'
const HASH = 'A'.repeat(64)

/** A store that outlives any one verifier, as Supabase or Redis would across a restart. */
class DurableStore implements SeenTxStore {
  readonly rows = new Map<string, SettlementRecord>()
  failWrites = false
  get(key: string): SettlementRecord | undefined {
    return this.rows.get(key)
  }
  set(key: string, record: SettlementRecord): void {
    if (this.failWrites) throw new Error('store down')
    this.rows.set(key, record)
  }
}

interface Block {
  confirmed?: string
  subtype?: string
  amount?: string
  link_as_account?: string
  representative?: string
  error?: string
}

function sendBlock(over: Block = {}): Record<string, unknown> {
  if (over.error) return { error: over.error }
  return {
    block_account: OTHER,
    amount: over.amount ?? PRICE,
    confirmed: over.confirmed ?? 'true',
    subtype: over.subtype ?? 'send',
    contents: {
      type: 'state',
      link_as_account: over.link_as_account ?? PAY_TO,
      representative: over.representative ?? COMMITMENT,
    },
  }
}

function fakeNode(block: Record<string, unknown> | 'down') {
  const calls: unknown[] = []
  const fetchImpl = (async (_url: unknown, init?: { body?: unknown }) => {
    calls.push(JSON.parse(String(init?.body)))
    if (block === 'down') throw new Error('connect ECONNREFUSED')
    return new Response(JSON.stringify(block), { status: 200 })
  }) as typeof fetch
  return { fetchImpl, calls }
}

function verifier(store: SeenTxStore, fetchImpl: typeof fetch, over: Partial<NanoExactOptions> = {}) {
  return createNanoExact({ payTo: PAY_TO, nodeUrl: NODE, seenTxStore: store, fetch: fetchImpl, ...over })
}

describe('xnoToRaw', () => {
  it('derives raw from 1 XNO = 10^30 raw', () => {
    assert.equal(xnoToRaw('1'), RAW_PER_XNO.toString())
    assert.equal(xnoToRaw('0.05'), (RAW_PER_XNO / 20n).toString())
    assert.equal(xnoToRaw('0.000000000000000000000000000001'), '1')
  })

  it('refuses zero, negatives, exponents and more than 30 decimals', () => {
    for (const bad of ['0', '-1', '1e3', '0.0000000000000000000000000000001', '', '1.']) {
      assert.throws(() => xnoToRaw(bad), RangeError, bad)
    }
  })
})

describe('nanoOrderCommitment', () => {
  it('matches the binding standard test vector', async () => {
    // #given the vector from xno-call-binding docs/BINDING-STANDARD.md (option C)
    const account = await nanoOrderCommitment('order-0001', OTHER, '50000000000000000000000000000')
    // #then
    assert.equal(account, 'nano_33q9dassq66es6mcay83n5kypqgpzjikr9bkc9ope9xch1borfphgehj4ozj')
  })
})

describe('createNanoExact configuration', () => {
  const { fetchImpl } = fakeNode(sendBlock())

  it('refuses a payTo that fails the checksum', () => {
    assert.throws(() => verifier(new DurableStore(), fetchImpl, { payTo: `${PAY_TO.slice(0, -1)}1` }), RangeError)
  })

  it('refuses a plain-http node that is not on loopback', () => {
    assert.throws(() => verifier(new DurableStore(), fetchImpl, { nodeUrl: 'http://node.example/rpc' }), RangeError)
    assert.doesNotThrow(() => verifier(new DurableStore(), fetchImpl, { nodeUrl: 'http://127.0.0.1:7076' }))
  })
})

describe('nano exact requirement', () => {
  it('describes one order: raw price, payee and the commitment to put in the block', async () => {
    // #given
    const { fetchImpl } = fakeNode(sendBlock())
    const nano = verifier(new DurableStore(), fetchImpl)
    // #when
    const req = await nano.requirement(PRICE, ORDER)
    // #then
    assert.deepEqual(req, {
      scheme: 'exact',
      network: NANO_MAINNET,
      asset: 'XNO',
      amount: PRICE,
      payTo: PAY_TO,
      maxTimeoutSeconds: 600,
      extra: { binding: 'xno-binding/v1/rep', orderId: ORDER, representative: COMMITMENT },
    })
  })

  it('issues a fresh random order id for every 402', async () => {
    const { fetchImpl } = fakeNode(sendBlock())
    const nano = verifier(new DurableStore(), fetchImpl)
    const a = await nano.requirement(PRICE)
    const b = await nano.requirement(PRICE)
    assert.match(a.extra.orderId, /^[0-9a-f]{32}$/)
    assert.notEqual(a.extra.orderId, b.extra.orderId)
    assert.notEqual(a.extra.representative, b.extra.representative)
  })
})

describe('nano exact verify', () => {
  it('accepts a confirmed send of the exact price to payTo committed to the order', async () => {
    // #given
    const store = new DurableStore()
    const { fetchImpl, calls } = fakeNode(sendBlock())
    // #when
    const result = await verifier(store, fetchImpl).verify({ blockHash: HASH.toLowerCase(), orderId: ORDER }, PRICE)
    // #then
    assert.deepEqual(result, { ok: true, txHash: HASH, amount: PRICE, payer: OTHER })
    assert.deepEqual(calls, [{ action: 'block_info', json_block: 'true', hash: HASH }])
    assert.ok(store.rows.has(`nano:exact:${HASH}`))
  })

  it('refuses the same block a second time, also from a new verifier after a restart', async () => {
    // #given one accepted payment
    const store = new DurableStore()
    const { fetchImpl, calls } = fakeNode(sendBlock())
    await verifier(store, fetchImpl).verify({ blockHash: HASH, orderId: ORDER }, PRICE)
    // #when the process restarts with the same durable store
    const afterRestart = verifier(store, fetchImpl)
    const again = await afterRestart.verify({ blockHash: HASH, orderId: ORDER }, PRICE)
    // #then
    assert.deepEqual(again, { ok: false, reason: 'spent' })
    assert.equal(calls.length, 1)
  })

  it('refuses a second concurrent presentation of one block', async () => {
    const { fetchImpl } = fakeNode(sendBlock())
    const nano = verifier(new DurableStore(), fetchImpl)
    const [a, b] = await Promise.all([
      nano.verify({ blockHash: HASH, orderId: ORDER }, PRICE),
      nano.verify({ blockHash: HASH, orderId: ORDER }, PRICE),
    ])
    assert.equal(a.ok, true)
    assert.deepEqual(b, { ok: false, reason: 'spent' })
  })

  it('refuses a block presented with another order id (bound to the order that was issued)', async () => {
    const { fetchImpl } = fakeNode(sendBlock())
    const result = await verifier(new DurableStore(), fetchImpl).verify({ blockHash: HASH, orderId: OTHER_ORDER }, PRICE)
    assert.deepEqual(result, { ok: false, reason: 'not-bound-to-order' })
  })

  it('refuses a block paid for a cheaper route', async () => {
    // #given a payment of 0.05 XNO, presented on a 0.1 XNO route
    const { fetchImpl } = fakeNode(sendBlock())
    const result = await verifier(new DurableStore(), fetchImpl).verify(
      { blockHash: HASH, orderId: ORDER },
      xnoToRaw('0.1'),
    )
    assert.deepEqual(result, { ok: false, reason: 'wrong-amount' })
  })

  const refusals: Array<[string, Record<string, unknown> | 'down', string]> = [
    ['an over-payment', sendBlock({ amount: (BigInt(PRICE) + 1n).toString() }), 'wrong-amount'],
    ['a payment to another account', sendBlock({ link_as_account: OTHER }), 'wrong-destination'],
    ['an unconfirmed block', sendBlock({ confirmed: 'false' }), 'unconfirmed'],
    ['a receive block', sendBlock({ subtype: 'receive' }), 'not-a-send'],
    ['a block without the order commitment', sendBlock({ representative: PAY_TO }), 'not-bound-to-order'],
    ['an unknown block', sendBlock({ error: 'Block not found' }), 'not-found'],
    ['an unreachable node', 'down', 'node-error'],
  ]
  for (const [name, block, reason] of refusals) {
    it(`refuses ${name} and records nothing`, async () => {
      const store = new DurableStore()
      const { fetchImpl } = fakeNode(block)
      const result = await verifier(store, fetchImpl).verify({ blockHash: HASH, orderId: ORDER }, PRICE)
      assert.deepEqual(result, { ok: false, reason })
      assert.equal(store.rows.size, 0)
    })
  }

  it('refuses malformed payloads without calling the node', async () => {
    const { fetchImpl, calls } = fakeNode(sendBlock())
    const nano = verifier(new DurableStore(), fetchImpl)
    for (const payload of [null, 'x', { blockHash: 'zz', orderId: ORDER }, { blockHash: HASH, orderId: 'order-1' }]) {
      assert.deepEqual(await nano.verify(payload, PRICE), { ok: false, reason: 'malformed-payload' })
    }
    assert.equal(calls.length, 0)
  })

  it('does not accept a payment whose claim could not be recorded', async () => {
    // #given a store that is down at write time
    const store = new DurableStore()
    store.failWrites = true
    const { fetchImpl } = fakeNode(sendBlock())
    // #when
    const result = await verifier(store, fetchImpl).verify({ blockHash: HASH, orderId: ORDER }, PRICE)
    // #then
    assert.deepEqual(result, { ok: false, reason: 'store-error' })
  })
})
