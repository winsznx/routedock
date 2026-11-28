import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'
import { ChannelSession } from '../ChannelSession.js'
import { TESTNET_USDC_CONTRACT } from '../manifest.js'
import type { Env } from '../env.js'

const TEST_PAYEE_SECRET = 'SBB3ER7UC7MYPQYHLNTX4QINRTV4WPFE2T644J64XTAUNKJMOGOVJGLL'
const TEST_PAYEE_ADDRESS = 'GBRLCID5A2S6HUC4D4DSWPRWNO75CLNHS2SIPS2BPCCP55Z5N7Z36DJD'
const TEST_CHANNEL_CONTRACT = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'

const env: Env = {
  STELLAR_NETWORK: 'testnet',
  STELLAR_PAYEE_SECRET: TEST_PAYEE_SECRET,
  STELLAR_PAYEE_ADDRESS: TEST_PAYEE_ADDRESS,
  COMMITMENT_PUBLIC_KEY: TEST_PAYEE_ADDRESS,
  CHANNEL_CONTRACT_ID: TEST_CHANNEL_CONTRACT,
  PUBLIC_BASE_URL: 'https://api-b.routedock.xyz',
  USDC_ASSET_CONTRACT: TESTNET_USDC_CONTRACT,
  CHANNEL_SESSION: {} as unknown as Env['CHANNEL_SESSION'],
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_KEY: 'service-key',
}

const realFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = realFetch
})

/** A Durable Object instance as the runtime constructs it after eviction. */
function newSession(pending: Promise<unknown>[]): ChannelSession {
  const session = Object.create(ChannelSession.prototype)
  Object.defineProperty(session, 'env', { value: env, writable: true })
  Object.defineProperty(session, 'ctx', {
    value: { waitUntil: (p: Promise<unknown>) => { pending.push(p) } },
    writable: true,
  })
  return session as ChannelSession
}

describe('provider-b registry registration', () => {
  it('leaves an operator-unverified row unverified across Durable Object constructions', async () => {
    // Like Postgres' ON CONFLICT DO UPDATE, a write only changes the columns it sends.
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

    // Two evictions: each request constructs the object again and runs buildApp.
    for (let i = 0; i < 2; i++) {
      const pending: Promise<unknown>[] = []
      const session = newSession(pending)
      await session.fetch(new Request('http://localhost/.well-known/routedock.json'))
      await Promise.all(pending)
    }

    assert.ok(providerWrites.length >= 1, 'registration reached the providers table')
    for (const body of providerWrites) {
      assert.equal('verified' in body, false, 'registration payload must not contain verified')
    }
    assert.equal(row?.['verified'], false)
    assert.equal(providerWrites.length, 1, 'the second construction, with an unchanged manifest, performs no write')
  })
})
