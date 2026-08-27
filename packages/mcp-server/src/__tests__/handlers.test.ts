import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import type { RouteDockManifest, EstimateCostResult } from '@routedock/routedock'
import {
  handlePayForData,
  handleOpenSession,
  handleStreamSession,
  handleCloseSession,
  handleCheckBalance,
  handleListProviders,
  type HandlerDeps,
  type ToolResult,
  type HorizonBalance,
  type ProviderRow,
  type SupabaseQueryBuilder,
} from '../handlers.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseResult(result: ToolResult): unknown {
  return JSON.parse(result.content[0]!.text)
}

/** Minimal RouteDockManifest fixture required by EstimateCostResult. */
const FAKE_MANIFEST: RouteDockManifest = {
  routedock: '1.0',
  name: 'Fake Provider',
  description: 'Test fixture provider',
  modes: ['x402'],
  network: 'testnet',
  asset: 'USDC',
  asset_contract: 'CFAKESACADDRESS',
  payee: 'GFAKEPAYEEADDRESS',
  pricing: {},
  endpoints: {},
  tags: [],
}

/** Build a valid EstimateCostResult for test fakes. */
function estimate(amount: string): EstimateCostResult {
  return { amount, asset: 'USDC', mode: 'x402', manifest: FAKE_MANIFEST }
}

/** Minimal fake RouteDockClient */
function makeClient(overrides: Partial<{
  estimateCost: HandlerDeps['client']['estimateCost']
  pay: HandlerDeps['client']['pay']
  openSession: HandlerDeps['client']['openSession']
}> = {}): HandlerDeps['client'] {
  return {
    estimateCost: overrides.estimateCost ?? (async () => estimate('0.001')),
    pay: overrides.pay ?? (async () => ({
      mode: 'x402' as const,
      amount: '0.001',
      txHash: 'TXHASH',
      timestamp: Date.now(),
      data: {},
    })),
    openSession: overrides.openSession ?? (async () => ({
      channelId: 'CHAN1',
      openTxHash: 'OPEN_TX',
      stream: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }),
      close: async () => ({ closeTxHash: 'CLOSE_TX', totalPaid: '0.01', vouchersIssued: 3 }),
    })),
  } as unknown as HandlerDeps['client']
}

/** Minimal fake Supabase client */
function makeSupabase(rows: unknown[], error: { message: string } | null = null): HandlerDeps['supabase'] {
  const terminal = Promise.resolve({ data: rows as ProviderRow[], error })
  const builder: unknown = Object.assign(terminal, {
    eq: () => builder,
    overlaps: () => builder,
  })
  return {
    from: (_table: string) => ({
      select: (_cols: string) => builder as SupabaseQueryBuilder,
    }),
  }
}

function baseDeps(overrides: Partial<HandlerDeps> = {}): HandlerDeps {
  return {
    client: makeClient(),
    openSessions: new Map(),
    supabase: null,
    stellarSecret: Keypair.random().secret(),
    stellarNetwork: 'testnet',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// pay_for_data
// ---------------------------------------------------------------------------

describe('handlePayForData', () => {
  it('returns success when estimate is within max_amount', async () => {
    const result = await handlePayForData(
      { url: 'https://provider.example.com/data', max_amount: '1.00' },
      baseDeps(),
    )
    assert.equal(result.isError, undefined)
    const body = parseResult(result) as any
    assert.equal(body.success, true)
    assert.equal(body.tx_hash, 'TXHASH')
  })

  it('returns isError when estimate exceeds max_amount', async () => {
    const deps = baseDeps({
      client: makeClient({
        estimateCost: async () => estimate('5.00'),
      }),
    })
    const result = await handlePayForData(
      { url: 'https://provider.example.com/data', max_amount: '1.00' },
      deps,
    )
    assert.equal(result.isError, true)
    const body = parseResult(result) as any
    assert.ok(body.error.includes('exceeds max_amount'))
  })

  it('returns isError when provider returns an undefined amount', async () => {
    const deps = baseDeps({
      client: makeClient({
        estimateCost: async () => ({ ...estimate('0'), amount: undefined as unknown as string }),
      }),
    })
    const result = await handlePayForData(
      { url: 'https://provider.example.com/data', max_amount: '1.00' },
      deps,
    )
    assert.equal(result.isError, true)
    const body = parseResult(result) as any
    assert.ok(body.error.includes('undefined or invalid price'))
  })

  it('passes forceMode (not preferredMode) to estimateCost and pay', async () => {
    let capturedModeOptions: unknown
    const deps = baseDeps({
      client: makeClient({
        estimateCost: async (_url: string, opts: unknown) => {
          capturedModeOptions = opts
          return estimate('0.001')
        },
      }),
    })
    await handlePayForData(
      { url: 'https://p.example.com/data', max_amount: '1.00', preferred_mode: 'mpp-charge' },
      deps,
    )
    assert.deepEqual(capturedModeOptions, { forceMode: 'mpp-charge' })
  })
})

// ---------------------------------------------------------------------------
// open_session
// ---------------------------------------------------------------------------

describe('handleOpenSession', () => {
  it('returns isError when COMMITMENT_SECRET is missing', async () => {
    const result = await handleOpenSession(
      { url: 'https://provider.example.com' },
      baseDeps(),
      undefined,
    )
    assert.equal(result.isError, true)
    const body = parseResult(result) as any
    assert.ok(body.error.includes('COMMITMENT_SECRET'))
  })

  it('opens a session and stores it in openSessions', async () => {
    const sessions = new Map()
    const result = await handleOpenSession(
      { url: 'https://provider.example.com' },
      baseDeps({ openSessions: sessions }),
      'secret123',
    )
    assert.equal(result.isError, undefined)
    const body = parseResult(result) as any
    assert.equal(body.success, true)
    assert.equal(body.channel_id, 'CHAN1')
    assert.ok(sessions.has('CHAN1'))
  })

  it('returns isError when initial_deposit is below min_deposit', async () => {
    const fakeManifest = {
      pricing: { 'mpp-session': { min_deposit: '10.0' } },
    }
    const fetchManifest = async (_url: string) => ({
      json: async () => fakeManifest,
    })
    const result = await handleOpenSession(
      { url: 'https://provider.example.com', initial_deposit: '1.0' },
      baseDeps({ fetchManifest }),
      'secret123',
    )
    assert.equal(result.isError, true)
    const body = parseResult(result) as any
    assert.ok(body.error.includes('min_deposit'))
  })

  it('passes when initial_deposit meets min_deposit', async () => {
    const fakeManifest = {
      pricing: { 'mpp-session': { min_deposit: '1.0' } },
    }
    const fetchManifest = async (_url: string) => ({
      json: async () => fakeManifest,
    })
    const sessions = new Map()
    const result = await handleOpenSession(
      { url: 'https://provider.example.com', initial_deposit: '5.0' },
      baseDeps({ openSessions: sessions, fetchManifest }),
      'secret123',
    )
    assert.equal(result.isError, undefined)
    assert.ok(sessions.has('CHAN1'))
  })
})

// ---------------------------------------------------------------------------
// stream_session
// ---------------------------------------------------------------------------

describe('handleStreamSession', () => {
  it('returns isError for unknown channel_id', async () => {
    const result = await handleStreamSession(
      { channel_id: 'MISSING' },
      baseDeps(),
    )
    assert.equal(result.isError, true)
    const body = parseResult(result) as any
    assert.ok(body.error.includes('No open session'))
  })

  it('pulls up to max_messages from the async iterator', async () => {
    const items = ['msg1', 'msg2', 'msg3']
    let idx = 0
    const fakeSession = {
      stream: () => ({
        [Symbol.asyncIterator]: () => ({
          next: async () =>
            idx < items.length
              ? { done: false, value: items[idx++] }
              : { done: true, value: undefined },
        }),
      }),
    }
    const sessions = new Map<string, any>([['CHAN1', fakeSession]])
    const result = await handleStreamSession(
      { channel_id: 'CHAN1', max_messages: 2 },
      baseDeps({ openSessions: sessions }),
    )
    assert.equal(result.isError, undefined)
    const body = parseResult(result) as any
    assert.equal(body.count, 2)
    assert.deepEqual(body.messages, ['msg1', 'msg2'])
  })

  it('stops early when stream is exhausted before max_messages', async () => {
    const items = ['only_one']
    let idx = 0
    const fakeSession = {
      stream: () => ({
        [Symbol.asyncIterator]: () => ({
          next: async () =>
            idx < items.length
              ? { done: false, value: items[idx++] }
              : { done: true, value: undefined },
        }),
      }),
    }
    const sessions = new Map<string, any>([['CHAN1', fakeSession]])
    const result = await handleStreamSession(
      { channel_id: 'CHAN1', max_messages: 10 },
      baseDeps({ openSessions: sessions }),
    )
    const body = parseResult(result) as any
    assert.equal(body.count, 1)
  })
})

// ---------------------------------------------------------------------------
// close_session
// ---------------------------------------------------------------------------

describe('handleCloseSession', () => {
  it('returns isError for unknown channel_id', async () => {
    const result = await handleCloseSession({ channel_id: 'MISSING' }, baseDeps())
    assert.equal(result.isError, true)
    const body = parseResult(result) as any
    assert.ok(body.error.includes('No open session'))
  })

  it('closes the session and removes it from openSessions', async () => {
    const fakeSession = {
      close: async () => ({
        closeTxHash: 'CLOSE_TX',
        totalPaid: '0.05',
        vouchersIssued: 5,
      }),
    }
    const sessions = new Map<string, any>([['CHAN1', fakeSession]])
    const result = await handleCloseSession(
      { channel_id: 'CHAN1' },
      baseDeps({ openSessions: sessions }),
    )
    assert.equal(result.isError, undefined)
    const body = parseResult(result) as any
    assert.equal(body.success, true)
    assert.equal(body.close_tx_hash, 'CLOSE_TX')
    assert.equal(body.total_paid, '0.05')
    assert.equal(body.vouchers_issued, 5)
    // Must be evicted
    assert.equal(sessions.has('CHAN1'), false)
  })
})

// ---------------------------------------------------------------------------
// check_balance
// ---------------------------------------------------------------------------

describe('handleCheckBalance', () => {
  const secret = Keypair.random().secret()
  const keypair = Keypair.fromSecret(secret)

  const makeHorizon = (balances: HorizonBalance[]) => (_url: string) => ({
    loadAccount: async (_pk: string) => ({ balances }),
  })

  it('returns XLM native balance when no asset specified', async () => {
    const deps = baseDeps({
      stellarSecret: secret,
      createHorizonServer: makeHorizon([{ asset_type: 'native', balance: '42.0000000' }]),
    })
    const result = await handleCheckBalance({}, deps)
    assert.equal(result.isError, undefined)
    const body = parseResult(result) as any
    assert.equal(body.asset, 'XLM')
    assert.equal(body.balance, '42.0000000')
    assert.equal(body.account, keypair.publicKey())
  })

  it('returns 0 when native balance entry is absent', async () => {
    const deps = baseDeps({
      stellarSecret: secret,
      createHorizonServer: makeHorizon([]),
    })
    const result = await handleCheckBalance({}, deps)
    const body = parseResult(result) as any
    assert.equal(body.balance, '0')
  })

  it('returns specific asset balance when asset_code provided', async () => {
    const deps = baseDeps({
      stellarSecret: secret,
      createHorizonServer: makeHorizon([
        { asset_code: 'USDC', asset_issuer: 'GA5...', balance: '100.00' },
      ]),
    })
    const result = await handleCheckBalance({ asset_code: 'USDC' }, deps)
    const body = parseResult(result) as any
    assert.equal(body.asset, 'USDC')
    assert.equal(body.balance, '100.00')
  })

  it('returns 0 when requested asset is not found', async () => {
    const deps = baseDeps({
      stellarSecret: secret,
      createHorizonServer: makeHorizon([]),
    })
    const result = await handleCheckBalance({ asset_code: 'USDC' }, deps)
    const body = parseResult(result) as any
    assert.equal(body.balance, '0')
  })

  it('returns specific asset balance when both asset_code and asset_issuer are provided', async () => {
    const deps = baseDeps({
      stellarSecret: secret,
      createHorizonServer: makeHorizon([
        { asset_code: 'USDC', asset_issuer: 'ISSUER1', balance: '55.50' },
      ]),
    })
    const result = await handleCheckBalance(
      { asset_code: 'USDC', asset_issuer: 'ISSUER1' },
      deps,
    )
    const body = parseResult(result) as any
    assert.equal(body.balance, '55.50')
    assert.equal(body.issuer, 'ISSUER1')
  })
})

// ---------------------------------------------------------------------------
// list_providers
// ---------------------------------------------------------------------------

describe('handleListProviders', () => {
  it('returns isError when supabase is null', async () => {
    const result = await handleListProviders({}, baseDeps({ supabase: null }))
    assert.equal(result.isError, true)
    const body = parseResult(result) as any
    assert.ok(body.error.includes('SUPABASE_URL'))
  })

  it('returns providers from supabase without filters', async () => {
    const rows = [
      { name: 'ProvA', description: 'desc', network: 'testnet', asset: 'USDC', modes: ['x402'], tags: ['price'], base_url: 'https://a.example.com' },
    ]
    const deps = baseDeps({ supabase: makeSupabase(rows) })
    const result = await handleListProviders({}, deps)
    assert.equal(result.isError, undefined)
    const body = parseResult(result) as any
    assert.equal(body.success, true)
    assert.equal(body.count, 1)
    assert.equal(body.providers[0].name, 'ProvA')
  })

  it('returns isError when supabase reports an error', async () => {
    const deps = baseDeps({ supabase: makeSupabase([], { message: 'DB error' }) })
    const result = await handleListProviders({}, deps)
    assert.equal(result.isError, true)
    const body = parseResult(result) as any
    assert.ok(body.error.includes('DB error'))
  })

  it('returns 0 providers when supabase returns empty array', async () => {
    const deps = baseDeps({ supabase: makeSupabase([]) })
    const result = await handleListProviders({}, deps)
    const body = parseResult(result) as any
    assert.equal(body.count, 0)
    assert.deepEqual(body.providers, [])
  })

  it('applies tag filter (overlaps)', async () => {
    const rows = [
      { name: 'ProvB', description: '', network: 'testnet', asset: 'USDC', modes: ['mpp-charge'], tags: ['dex'], base_url: 'https://b.example.com' },
    ]
    let calledOverlaps = false
    const supabase: HandlerDeps['supabase'] = {
      from: (_t: string) => ({
        select: (_c: string) => ({
          overlaps: (_f: string, _v: unknown) => {
            calledOverlaps = true
            return Promise.resolve({ data: rows, error: null })
          },
          eq: (_f: string, _v: unknown) => ({
            overlaps: (_f2: string, _v2: unknown) => {
              calledOverlaps = true
              return Promise.resolve({ data: rows, error: null })
            },
          }),
        }),
      }),
    }
    const deps = baseDeps({ supabase })
    const result = await handleListProviders({ tags: 'dex,price' }, deps)
    assert.ok(calledOverlaps, 'overlaps() should have been called for tag filtering')
    const body = parseResult(result) as any
    assert.equal(body.providers[0].name, 'ProvB')
  })
})
