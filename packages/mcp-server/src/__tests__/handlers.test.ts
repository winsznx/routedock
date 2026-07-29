import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  handlePayForData,
  handleOpenSession,
  handleCheckBalance,
  handleListProviders,
} from '../handlers.js'
import type { RouteDockClient } from '@routedock/routedock'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseResult(result: any) {
  const first = result.content[0]
  if (!first) throw new Error('No content in result')
  return JSON.parse(first.text)
}

function makeClientMock(overrides: Partial<RouteDockClient> = {}): RouteDockClient {
  return {
    pay: async (_url: string) => ({
      mode: 'x402',
      amount: '0.001',
      txHash: 'mock-tx-hash',
      timestamp: Date.now(),
      data: { result: 42 },
    }),
    openSession: async (_url: string) => ({
      channelId: 'mock-channel-id',
      openTxHash: 'mock-open-tx',
    }),
    ...overrides,
  } as unknown as RouteDockClient
}

function makeSupabaseMock(rows: object[] | null, error: object | null = null) {
  return {
    from: () => ({
      select: () => ({
        eq: function (this: any) { return this },
        textSearch: function (this: any) { return this },
        then: undefined,
        // make it thenable (allows await)
        [Symbol.iterator]: undefined,
      }),
    }),
  }
}

// Supabase mock that resolves the full query chain
function makeSupabaseQueryMock(rows: object[] | null, error: object | null = null) {
  const chainable = {
    eq: function (this: any) { return this },
    textSearch: function (this: any) { return this },
    then: (resolve: Function) => resolve({ data: rows, error }),
  }
  return {
    from: () => ({
      select: () => chainable,
    }),
  }
}

// ---------------------------------------------------------------------------
// handlePayForData
// ---------------------------------------------------------------------------

describe('handlePayForData — success', () => {
  it('returns success shape with mode and tx_hash', async () => {
    const client = makeClientMock()
    const result = await handlePayForData({ url: 'https://provider.example.com/price' }, client)
    const body = parseResult(result)
    assert.equal(body.success, true)
    assert.equal(body.mode, 'x402')
    assert.equal(body.tx_hash, 'mock-tx-hash')
  })
})

describe('handlePayForData — max_amount exceeded', () => {
  it('returns error when provider price exceeds max_amount', async () => {
    // We mock fetch to return a manifest with a high price
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () =>
      ({
        json: async () => ({
          pricing: { x402: { amount: '0.10' } },
        }),
      } as unknown as typeof fetch extends (...args: any[]) => Promise<infer R> ? R : never)

    const client = makeClientMock()
    const result = await handlePayForData(
      { url: 'https://provider.example.com/price', max_amount: '0.001' },
      client,
    )
    const body = parseResult(result)
    assert.equal(body.success, false)
    assert.match(body.error, /exceeds max_amount/)

    globalThis.fetch = originalFetch
  })
})

describe('handlePayForData — client throws', () => {
  it('returns error result when client.pay throws', async () => {
    const client = makeClientMock({
      pay: async () => { throw new Error('Network error') },
    } as any)
    const result = await handlePayForData({ url: 'https://provider.example.com/price' }, client)
    const body = parseResult(result)
    assert.equal(body.success, false)
    assert.equal(result.isError, true)
  })
})

// ---------------------------------------------------------------------------
// handleOpenSession
// ---------------------------------------------------------------------------

describe('handleOpenSession — success', () => {
  it('returns channel_id and open_tx_hash', async () => {
    const client = makeClientMock()
    const result = await handleOpenSession({ url: 'https://provider.example.com' }, client, 'SECRET123')
    const body = parseResult(result)
    assert.equal(body.success, true)
    assert.equal(body.channel_id, 'mock-channel-id')
  })
})

describe('handleOpenSession — missing commitmentSecret', () => {
  it('returns error when commitmentSecret is not provided', async () => {
    const client = makeClientMock()
    const result = await handleOpenSession({ url: 'https://provider.example.com' }, client, undefined)
    const body = parseResult(result)
    assert.equal(body.success, false)
    assert.match(body.error, /COMMITMENT_SECRET/)
    assert.equal(result.isError, true)
  })
})

// ---------------------------------------------------------------------------
// handleCheckBalance — mocked via no real Horizon calls needed
// (we test error handling path since real Horizon needs network)
// ---------------------------------------------------------------------------

describe('handleCheckBalance — invalid key', () => {
  it('returns error result when secret key is invalid', async () => {
    const result = await handleCheckBalance({}, 'INVALID-SECRET', 'testnet')
    const body = parseResult(result)
    assert.equal(body.success, false)
    assert.equal(result.isError, true)
  })
})

// ---------------------------------------------------------------------------
// handleListProviders
// ---------------------------------------------------------------------------

describe('handleListProviders — no supabase', () => {
  it('returns error when supabase is null', async () => {
    const result = await handleListProviders({}, null)
    const body = parseResult(result)
    assert.equal(body.success, false)
    assert.match(body.error, /SUPABASE_URL/)
    assert.equal(result.isError, true)
  })
})

describe('handleListProviders — success', () => {
  it('returns mapped provider list', async () => {
    const rows = [
      {
        name: 'Test Provider',
        description: 'A provider',
        network: 'testnet',
        asset: 'USDC',
        modes: ['x402'],
        tags: ['ai'],
        base_url: 'https://provider.example.com',
      },
    ]
    const supabase = makeSupabaseQueryMock(rows) as any
    const result = await handleListProviders({}, supabase)
    const body = parseResult(result)
    assert.equal(body.success, true)
    assert.equal(body.count, 1)
    assert.equal(body.providers[0].name, 'Test Provider')
  })
})

describe('handleListProviders — supabase error', () => {
  it('returns error result when supabase query fails', async () => {
    const supabase = makeSupabaseQueryMock(null, { message: 'Connection refused' }) as any
    const result = await handleListProviders({}, supabase)
    const body = parseResult(result)
    assert.equal(body.success, false)
    assert.equal(result.isError, true)
  })
})
