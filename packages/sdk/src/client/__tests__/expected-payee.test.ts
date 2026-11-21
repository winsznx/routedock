import assert from 'node:assert/strict'
import { describe, it, type TestContext } from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import { RouteDockClient, type RouteDockClientConfig } from '../RouteDockClient.js'
import { MppChargeClient } from '../MppChargeClient.js'
import { MppSessionClient } from '../MppSessionClient.js'
import { RouteDockPolicyRejectError, RouteDockSignatureError } from '../../errors.js'
import { signManifest } from '../../manifest/sign.js'
import { InMemorySpendStore } from '../../store/SpendStore.js'
import type { RouteDockManifest } from '../../types.js'

function provider(payee = Keypair.random()) {
  const baseUrl = `https://${Keypair.random().publicKey().toLowerCase()}.example`
  const manifest: RouteDockManifest = signManifest({
    routedock: '1.0',
    name: 'Anchored Provider',
    description: 'Per-call payee binding fixture',
    modes: ['mpp-charge', 'mpp-session'],
    network: 'testnet',
    asset: 'USDC',
    asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    payee: payee.publicKey(),
    pricing: {
      'mpp-charge': { amount: '0.006', per: 'request' },
      'mpp-session': {
        rate: '0.0001',
        per: 'voucher',
        channel_factory: 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH',
        min_deposit: '0.10',
        refund_waiting_period_ledgers: 17280,
      },
    },
    endpoints: { data: { method: 'GET', path: '/data' } },
    tags: ['test'],
  }, payee.secret())
  return { baseUrl, url: `${baseUrl}/data`, manifest, payee: payee.publicKey() }
}

function serve(t: TestContext, providers: ReturnType<typeof provider>[]) {
  const manifests = new Map(providers.map((p) => [`${p.baseUrl}/.well-known/routedock.json`, p.manifest] as const))
  return t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const manifest = manifests.get(url)
    assert.ok(manifest, `unexpected request before payment: ${url}`)
    return new Response(JSON.stringify(manifest), {
      headers: { 'content-type': 'application/json', 'cache-control': 'max-age=60' },
    })
  })
}

function clientFor(t: TestContext, config: Partial<RouteDockClientConfig> = {}) {
  const client = new RouteDockClient({ wallet: Keypair.random(), network: 'testnet', ...config })
  const internals = client as unknown as { _checkTrustline: () => Promise<void> }
  t.mock.method(internals, '_checkTrustline', async () => undefined)
  const pay = t.mock.method(MppChargeClient.prototype, 'pay', async (_url: string, manifest: RouteDockManifest) => ({
    data: { payee: manifest.payee },
    txHash: 'settled-payment',
    mode: 'mpp-charge' as const,
    amount: manifest.pricing['mpp-charge']!.amount,
    timestamp: Date.now(),
  }))
  return { client, pay }
}

describe('RouteDockClient per-call expectedPayee (issue #729)', () => {
  for (const warm of [false, true]) {
    it(`pay rejects a mismatched anchor on a ${warm ? 'warm' : 'cold'} cache before dispatch`, async (t) => {
      // #given a correctly signed manifest from another payee
      const p = provider()
      const fetch = serve(t, [p])
      const { client, pay } = clientFor(t)
      if (warm) await client.estimateCost(p.url)

      // #when the payment is bound to a different registry account
      await assert.rejects(
        client.pay(p.url, { expectedPayee: Keypair.random().publicKey() }),
        RouteDockSignatureError,
      )

      // #then cache reuse cannot bypass the binding or dispatch a payment
      assert.equal(pay.mock.callCount(), 0)
      assert.equal(fetch.mock.callCount(), 1)
    })
  }

  it('pay overrides the client anchor for this call and retains the default afterwards', async (t) => {
    const p = provider()
    serve(t, [p])
    const { client, pay } = clientFor(t, { expectedPayee: Keypair.random().publicKey() })

    const result = await client.pay(p.url, { expectedPayee: p.payee })
    assert.deepEqual(result.data, { payee: p.payee })
    await assert.rejects(client.pay(p.url), RouteDockSignatureError)
    assert.equal(pay.mock.callCount(), 1)
  })

  it('calls without a client or per-call anchor preserve unbound behavior', async (t) => {
    const p = provider()
    serve(t, [p])
    const { client, pay } = clientFor(t)

    await client.pay(p.url)
    assert.equal(pay.mock.callCount(), 1)
  })

  it('estimateCost enforces and overrides the anchor on cold and warm manifests', async (t) => {
    const p = provider()
    const fetch = serve(t, [p])
    const wrongPayee = Keypair.random().publicKey()
    const { client, pay } = clientFor(t, { expectedPayee: wrongPayee })

    await assert.rejects(client.estimateCost(p.url), RouteDockSignatureError)
    const estimate = await client.estimateCost(p.url, { expectedPayee: p.payee })
    assert.equal(estimate.manifest.payee, p.payee)
    await assert.rejects(client.estimateCost(p.url, { expectedPayee: wrongPayee }), RouteDockSignatureError)
    assert.equal(fetch.mock.callCount(), 1)
    assert.equal(pay.mock.callCount(), 0)
  })

  it('preflight(url, options) overrides and rechecks the anchor without moving money', async (t) => {
    const p = provider()
    const fetch = serve(t, [p])
    const { client, pay } = clientFor(t, { expectedPayee: Keypair.random().publicKey() })

    await assert.rejects(client.preflight(p.url), RouteDockSignatureError)
    const result = await client.preflight(p.url, { expectedPayee: p.payee })
    assert.deepEqual(result.modes, ['mpp-charge', 'mpp-session'])
    await assert.rejects(
      client.preflight(p.url, { expectedPayee: Keypair.random().publicKey() }),
      RouteDockSignatureError,
    )
    assert.equal(fetch.mock.callCount(), 1)
    assert.equal(pay.mock.callCount(), 0)
  })

  for (const warm of [false, true]) {
    it(`openSession rejects a mismatched ${warm ? 'warm' : 'cold'} manifest before signing`, async (t) => {
      const p = provider()
      serve(t, [p])
      const { client } = clientFor(t, { commitmentSecret: Keypair.random().secret() })
      const open = t.mock.method(MppSessionClient.prototype, 'openSession', async () => {
        assert.fail('no channel or voucher may be opened for an unbound provider')
      })
      if (warm) await client.estimateCost(p.url)

      await assert.rejects(
        client.openSession(p.url, { expectedPayee: Keypair.random().publicKey() }),
        RouteDockSignatureError,
      )
      assert.equal(open.mock.callCount(), 0)
    })
  }

  it('openSession overrides the constructor anchor before handing off to the session client', async (t) => {
    const p = provider()
    serve(t, [p])
    const { client } = clientFor(t, {
      expectedPayee: Keypair.random().publicKey(),
      commitmentSecret: Keypair.random().secret(),
    })
    const handoff = new Error('session handoff reached')
    const open = t.mock.method(MppSessionClient.prototype, 'openSession', async () => { throw handoff })

    await assert.rejects(client.openSession(p.url, { expectedPayee: p.payee }), (error) => error === handoff)
    await assert.rejects(client.openSession(p.url), RouteDockSignatureError)
    assert.equal(open.mock.callCount(), 1)
  })

  it('two providers with different anchors share one daily spend total', async (t) => {
    // #given one client and two separately signed provider manifests
    const a = provider()
    const b = provider()
    serve(t, [a, b])
    const store = new InMemorySpendStore({ warn: false })
    const { client, pay } = clientFor(t, {
      spendCap: { daily: '0.012', asset: 'USDC' },
      spendStore: store,
    })

    // #when each provider is paid with its own registry anchor
    await assert.rejects(client.pay(a.url, { expectedPayee: b.payee }), RouteDockSignatureError)
    await client.pay(a.url, { expectedPayee: a.payee })
    await client.pay(b.url, { expectedPayee: b.payee })

    // #then both amounts count against the same cap
    assert.equal((await store.read())?.totalMicros, '120000')
    await assert.rejects(
      client.pay(a.url, { expectedPayee: a.payee }),
      (error: unknown) => error instanceof RouteDockPolicyRejectError && error.reason === 'local_daily_cap_exceeded',
    )
    assert.equal(pay.mock.callCount(), 2)
  })
})
