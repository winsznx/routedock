import assert from 'node:assert/strict'
import test from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import { RouteDockClient } from '../RouteDockClient.js'
import { X402Client } from '../x402Client.js'
import { MppChargeClient } from '../MppChargeClient.js'
import { RouteDockPolicyRejectError } from '../../errors.js'
import { signManifest } from '../../manifest/sign.js'
import { InMemorySpendStore } from '../../store/SpendStore.js'
import type { PaymentMode, PaymentResult, RouteDockManifest } from '../../types.js'

const PAYEE = Keypair.random()
const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const MODES = ['x402', 'mpp-charge'] as const

function manifest(mode: typeof MODES[number], amount: string): RouteDockManifest {
  const pricing: RouteDockManifest['pricing'] = mode === 'x402'
    ? { x402: { amount, per: 'request', facilitator: 'https://facilitator.test' } }
    : { 'mpp-charge': { amount, per: 'request' } }
  return signManifest({
    routedock: '1.0',
    name: 'Payment Ceiling Provider',
    description: 'Signed manifest for per-payment ceiling regressions',
    modes: [mode],
    network: 'testnet',
    asset: 'USDC',
    asset_contract: ASSET_CONTRACT,
    payee: PAYEE.publicKey(),
    pricing,
    endpoints: { data: { method: 'GET', path: '/data' } },
    tags: ['test'],
  }, PAYEE.secret())
}

function result(mode: PaymentMode, amount: string): PaymentResult {
  return { mode, amount, txHash: 'PAID_TX', timestamp: Date.now(), data: { ok: true } }
}

function privateClient(client: RouteDockClient): { _checkTrustline: () => Promise<void> } {
  return client as unknown as { _checkTrustline: () => Promise<void> }
}

for (const mode of MODES) {
  test('pay maxAmount refuses a repriced no-store manifest in ' + mode, async (t) => {
    // #given: an earlier estimate is cheap, but the payment fetch costs more.
    const store = new InMemorySpendStore({ warn: false })
    const client = new RouteDockClient({
      wallet: Keypair.random(),
      network: 'testnet',
      spendCap: { daily: '1', asset: 'USDC' },
      spendStore: store,
    })
    let manifestFetches = 0
    t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
      assert.ok(String(input).endsWith('/.well-known/routedock.json'))
      manifestFetches++
      return new Response(JSON.stringify(manifest(mode, manifestFetches === 1 ? '0.001' : '0.5')), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      })
    })
    const trustline = t.mock.method(privateClient(client), '_checkTrustline', async () => {})
    const payment = t.mock.method(
      mode === 'x402' ? X402Client.prototype : MppChargeClient.prototype,
      'pay',
      async () => result(mode, '0.5'),
    )
    const url = 'https://ceiling-' + mode + '.test/data'
    const estimate = await client.estimateCost(url, { forceMode: mode })
    assert.equal(estimate.amount, '0.001')

    // #when: the same client pays with the caller's original ceiling.
    await assert.rejects(
      client.pay(url, { forceMode: mode, maxAmount: '0.01' }),
      (error: unknown) => error instanceof RouteDockPolicyRejectError && error.reason === 'max_amount_exceeded',
    )

    // #then: neither trustline RPC, reservation nor payment dispatch took place.
    assert.equal(manifestFetches, 2)
    assert.equal(trustline.mock.callCount(), 0)
    assert.equal(payment.mock.callCount(), 0)
    assert.equal(await store.read(), null)
  })

  test('pay maxAmount accepts an equal decimal amount and reaches ' + mode + ' guard', async (t) => {
    // #given: equivalent decimal representations at the exact ceiling.
    const store = new InMemorySpendStore({ warn: false })
    const client = new RouteDockClient({
      wallet: Keypair.random(),
      network: 'testnet',
      spendCap: { daily: '1', asset: 'USDC' },
      spendStore: store,
    })
    t.mock.method(globalThis, 'fetch', async () => new Response(
      JSON.stringify(manifest(mode, '0.0100000')),
      { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
    ))
    t.mock.method(privateClient(client), '_checkTrustline', async () => {})
    let ceiling: string | undefined
    t.mock.method(
      mode === 'x402' ? X402Client.prototype : MppChargeClient.prototype,
      'pay',
      async (_url: string, _manifest: RouteDockManifest, _request: unknown, maxAmount?: string) => {
        ceiling = maxAmount
        return result(mode, '0.01')
      },
    )

    // #when: a discrete payment succeeds at the caller's limit.
    await client.pay('https://equal-' + mode + '.test/data', { forceMode: mode, maxAmount: '0.01' })

    // #then: the challenge client has the same ceiling and the daily total commits.
    assert.equal(ceiling, '0.01')
    assert.equal((await store.read())?.totalMicros, '100000')
  })

  for (const [ceiling, expectedReason] of [
    ['0.0099999', 'max_amount_exceeded'],
    ['0', 'max_amount_exceeded'],
    ['abc', 'max_amount_invalid'],
    ['-1', 'max_amount_invalid'],
    ['0.00000001', 'max_amount_invalid'],
  ] as const) {
    test('pay rejects maxAmount ' + ceiling + ' before dispatch in ' + mode, async (t) => {
      // #given: a valid one-cent manifest and an unusable ceiling.
      const client = new RouteDockClient({ wallet: Keypair.random(), network: 'testnet' })
      t.mock.method(globalThis, 'fetch', async () => new Response(
        JSON.stringify(manifest(mode, '0.01')),
        { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
      ))
      const trustline = t.mock.method(privateClient(client), '_checkTrustline', async () => {})
      const payment = t.mock.method(
        mode === 'x402' ? X402Client.prototype : MppChargeClient.prototype,
        'pay',
        async () => result(mode, '0.01'),
      )

      // #when / #then: a typed policy rejection precedes any payment work.
      await assert.rejects(
        client.pay('https://invalid-' + mode + '.test/data', { forceMode: mode, maxAmount: ceiling }),
        (error: unknown) => error instanceof RouteDockPolicyRejectError && error.reason === expectedReason,
      )
      assert.equal(trustline.mock.callCount(), 0)
      assert.equal(payment.mock.callCount(), 0)
    })
  }
}
