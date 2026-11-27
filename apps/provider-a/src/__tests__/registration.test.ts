import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import type { Env } from '../worker.js'
import { TESTNET_USDC_CONTRACT } from '../manifest.js'

const TEST_PAYEE_SECRET = 'SBB3ER7UC7MYPQYHLNTX4QINRTV4WPFE2T644J64XTAUNKJMOGOVJGLL'
const TEST_PAYEE_ADDRESS = 'GBRLCID5A2S6HUC4D4DSWPRWNO75CLNHS2SIPS2BPCCP55Z5N7Z36DJD'

const env: Env = {
  STELLAR_NETWORK: 'testnet',
  STELLAR_PAYEE_SECRET: TEST_PAYEE_SECRET,
  STELLAR_PAYEE_ADDRESS: TEST_PAYEE_ADDRESS,
  PUBLIC_BASE_URL: 'https://api-a.routedock.xyz',
  USDC_ASSET_CONTRACT: TESTNET_USDC_CONTRACT,
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_KEY: 'service-key',
}

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

describe('provider-a registry registration', () => {
  it('leaves an operator-unverified row unverified across isolate starts', async () => {
    // Row an operator already set to verified = false. Like Postgres'
    // ON CONFLICT DO UPDATE, a write only changes the columns it sends.
    let row: Record<string, unknown> | null = { verified: false, manifest_digest: null }
    const providerWrites: Record<string, unknown>[] = []

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
      if (!url.pathname.endsWith('/rest/v1/providers')) {
        return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })
      }
      if ((init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify(row ? [row] : []), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      providerWrites.push(body)
      row = { ...row, ...body }
      return new Response(null, { status: 201 })
    }) as typeof fetch

    // Two cold starts: each is a fresh isolate that runs createApp.
    for (let i = 0; i < 2; i++) {
      const pending: Promise<unknown>[] = []
      const ctx = {
        waitUntil: (p: Promise<unknown>) => { pending.push(p) },
        passThroughOnException() {},
      } as unknown as ExecutionContext
      // A fresh module instance has an empty cachedApp, like a new isolate.
      const { default: worker } = (await import(`../worker.js?cold=${i}`)) as typeof import('../worker.js')
      await worker.fetch(new Request('http://localhost/.well-known/routedock.json'), env, ctx)
      await Promise.all(pending)
    }

    assert.ok(providerWrites.length >= 1, 'registration reached the providers table')
    for (const body of providerWrites) {
      assert.equal('verified' in body, false, 'registration payload must not contain verified')
    }
    assert.equal(row?.['verified'], false)
    assert.equal(providerWrites.length, 1, 'the second start, with an unchanged manifest, performs no write')
  })
})
