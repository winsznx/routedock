import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import type { RouteDockManifest, EstimateCostResult } from '@routedock/routedock'
import { USDC_ISSUERS } from '@routedock/routedock/network'
import {
  handlePayForData,
  handleOpenSession,
  handleStreamSession,
  handleCloseSession,
  handleCheckBalance,
  handleListProviders,
  type HandlerDeps,
  type PayForDataArgs,
  type ToolResult,
  type HorizonBalance,
  type ProviderRow,
  type SupabaseQueryBuilder,
} from '../handlers.js'
import { MAX_PROVIDER_ROWS, MAX_STREAM_MESSAGES, TOOLS } from '../tools.js'

// ---------------------------------------------------------------------------
// Tool schema regression guard (issue #272)
// Pins the pay_for_data preferred_mode enum against the SDK's PaymentMode so
// future mode additions cause this test to fail rather than drift silently.
// ---------------------------------------------------------------------------

/** The canonical set of modes exported by the SDK. Kept as a const so any
 *  addition to PaymentMode surfaces here as a type error before the test runs. */
const SDK_PAYMENT_MODES = ['x402', 'mpp-charge', 'mpp-session', 'mpp-session-ws'] as const
type _AssertPaymentModes = (typeof SDK_PAYMENT_MODES)[number] extends import('@routedock/routedock').PaymentMode
  ? import('@routedock/routedock').PaymentMode extends (typeof SDK_PAYMENT_MODES)[number]
    ? true
    : never
  : never

describe('TOOLS schema regression', () => {
  it('pay_for_data preferred_mode enum matches SDK PaymentMode exactly', () => {
    const tool = TOOLS.find((t) => t.name === 'pay_for_data')
    assert.ok(tool, 'pay_for_data tool must exist in TOOLS')

    const enumValues = (tool.inputSchema as unknown as {
      properties: { preferred_mode: { enum: string[] } }
    }).properties.preferred_mode.enum

    const expected = [...SDK_PAYMENT_MODES].sort()
    const actual = [...enumValues].sort()

    assert.deepEqual(
      actual,
      expected,
      `Tool enum ${JSON.stringify(actual)} must match SDK PaymentMode ${JSON.stringify(expected)}`,
    )
  })

  it('stream_session max_messages is a bounded integer', () => {
    const tool = TOOLS.find((t) => t.name === 'stream_session')
    assert.ok(tool, 'stream_session tool must exist in TOOLS')

    const schema = (tool.inputSchema as unknown as {
      properties: { max_messages: { type: string; minimum: number; maximum: number } }
    }).properties.max_messages

    assert.equal(schema.type, 'integer')
    assert.equal(schema.minimum, 1)
    assert.equal(schema.maximum, MAX_STREAM_MESSAGES)
    assert.equal(MAX_STREAM_MESSAGES, 50)
  })

  it('list_providers limit is bounded and network documents its default (issue #566)', () => {
    const tool = TOOLS.find((t) => t.name === 'list_providers')
    assert.ok(tool, 'list_providers tool must exist in TOOLS')

    const properties = (tool.inputSchema as unknown as {
      properties: {
        limit: { type: string; minimum: number; maximum: number }
        network: { description: string }
      }
    }).properties

    assert.equal(properties.limit.type, 'integer')
    assert.equal(properties.limit.minimum, 1)
    assert.equal(properties.limit.maximum, MAX_PROVIDER_ROWS)
    assert.equal(MAX_PROVIDER_ROWS, 50)
    assert.ok(
      properties.network.description.includes('STELLAR_NETWORK'),
      'network must document that it defaults to the server network',
    )
  })

  it('open_session url describes the streaming endpoint, not a base URL (issue #317)', () => {
    const tool = TOOLS.find((t) => t.name === 'open_session')
    assert.ok(tool, 'open_session tool must exist in TOOLS')

    const description = (tool.inputSchema as unknown as {
      properties: { url: { description: string } }
    }).properties.url.description

    assert.ok(description.includes('https://api-b.routedock.xyz/stream/orderbook'))
    assert.ok(!description.toLowerCase().includes('the base url of the provider'))
  })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseResult(result: ToolResult): unknown {
  return JSON.parse(result.content[0]!.text)
}

/** Typed view of a handler payload, for assertions that stay off `any`. */
function payload(result: ToolResult): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>
}

/** The first provider of a list_providers payload, asserting there is one. */
function firstProvider(result: ToolResult): Record<string, unknown> {
  const providers = (payload(result).providers ?? []) as Record<string, unknown>[]
  assert.ok(providers.length > 0, 'expected at least one provider in the payload')
  return providers[0]!
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

/** Records the builder chain the handler builds, for query-shape assertions. */
interface SupabaseCalls {
  select: string
  eq: Array<[string, unknown]>
  overlaps: Array<[string, string[]]>
  limit: number[]
  order: Array<[string, { ascending?: boolean }]>
}

function newSupabaseCalls(): SupabaseCalls {
  return { select: '', eq: [], overlaps: [], limit: [], order: [] }
}

/** Minimal fake Supabase client.  Pass `calls` to assert the query shape. */
function makeSupabase(
  rows: unknown[],
  error: { message: string } | null = null,
  calls?: SupabaseCalls,
): HandlerDeps['supabase'] {
  const terminal = Promise.resolve({ data: rows as ProviderRow[], error })
  const builder: unknown = Object.assign(terminal, {
    eq: (field: string, value: unknown) => {
      calls?.eq.push([field, value])
      return builder
    },
    overlaps: (field: string, values: string[]) => {
      calls?.overlaps.push([field, values])
      return builder
    },
    limit: (n: number) => {
      calls?.limit.push(n)
      return builder
    },
    order: (column: string, options?: { ascending?: boolean }) => {
      calls?.order.push([column, options ?? {}])
      return builder
    },
  })
  return {
    from: (_table: string) => ({
      select: (cols: string) => {
        if (calls) calls.select = cols
        return builder as SupabaseQueryBuilder
      },
    }),
  }
}

/** Fake session that yields each item once, then reports done. */
function makeStreamSession(items: unknown[]) {
  let idx = 0
  return {
    stream: () => ({
      [Symbol.asyncIterator]: () => ({
        next: async () =>
          idx < items.length
            ? { done: false, value: items[idx++] }
            : { done: true, value: undefined },
      }),
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
  // -------------------------------------------------------------------------
  // max_amount validation (issue #316). MCP never validates arguments against
  // inputSchema, so a missing or non-numeric max_amount used to compare as NaN
  // and pay with no ceiling.
  // -------------------------------------------------------------------------

  /** Deps whose fake client quotes `price` and records which calls ran. */
  function payDeps(price: string | undefined) {
    const calls = { estimateCost: 0, pay: 0 }
    const deps = baseDeps({
      client: makeClient({
        estimateCost: async () => {
          calls.estimateCost++
          return { ...estimate('0'), amount: price as string }
        },
        pay: async () => {
          calls.pay++
          return { mode: 'x402' as const, amount: price ?? '', txHash: 'TXHASH', timestamp: Date.now(), data: {} }
        },
      }),
    })
    return { deps, calls }
  }

  function errorText(result: ToolResult): string {
    return (parseResult(result) as { error: string }).error
  }

  const INVALID_MAX_AMOUNTS: Array<[string, unknown]> = [
    ['missing', undefined],
    ['""', ''],
    ['null', null],
    ['"$0.01"', '$0.01'],
    ['"abc"', 'abc'],
    ['"one cent"', 'one cent'],
    ['"0"', '0'],
    ['"-1"', '-1'],
    ['the number 0.01', 0.01],
  ]

  for (const [label, maxAmount] of INVALID_MAX_AMOUNTS) {
    it(`rejects max_amount ${label} before estimating or paying`, async () => {
      const { deps, calls } = payDeps('5.00')
      const args = { url: 'https://provider.example.com/data', max_amount: maxAmount }
      if (maxAmount === undefined) delete args.max_amount
      const result = await handlePayForData(args as unknown as PayForDataArgs, deps)
      assert.equal(result.isError, true)
      assert.ok(errorText(result).includes('max_amount must be a positive USDC amount'))
      assert.deepEqual(calls, { estimateCost: 0, pay: 0 })
    })
  }

  it('rejects a 5.00 price against max_amount "0.01" without paying', async () => {
    const { deps, calls } = payDeps('5.00')
    const result = await handlePayForData(
      { url: 'https://provider.example.com/data', max_amount: '0.01' },
      deps,
    )
    assert.equal(result.isError, true)
    assert.ok(errorText(result).includes('exceeds max_amount'))
    assert.equal(calls.pay, 0)
  })

  for (const price of ['0.01', '0.0100000']) {
    it(`pays when price "${price}" equals max_amount "0.01"`, async () => {
      const { deps, calls } = payDeps(price)
      const result = await handlePayForData(
        { url: 'https://provider.example.com/data', max_amount: '0.01' },
        deps,
      )
      assert.equal(result.isError, undefined)
      assert.equal(calls.pay, 1)
    })
  }

  it('rejects a price one stroop above max_amount', async () => {
    const { deps, calls } = payDeps('0.0100001')
    const result = await handlePayForData(
      { url: 'https://provider.example.com/data', max_amount: '0.01' },
      deps,
    )
    assert.equal(result.isError, true)
    assert.ok(errorText(result).includes('exceeds max_amount'))
    assert.equal(calls.pay, 0)
  })

  for (const price of ['abc', '0.00000001']) {
    it(`rejects an unparseable provider price "${price}" without paying`, async () => {
      const { deps, calls } = payDeps(price)
      const result = await handlePayForData(
        { url: 'https://provider.example.com/data', max_amount: '1.00' },
        deps,
      )
      assert.equal(result.isError, true)
      assert.ok(errorText(result).includes('undefined or invalid price'))
      assert.equal(calls.pay, 0)
    })
  }
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
      { url: 'https://provider.example.com/stream/orderbook' },
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
      endpoints: { stream: { method: 'GET', path: '/stream/orderbook' } },
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

  it('reads min_deposit from mpp-session-ws when mpp-session is absent', async () => {
    const fakeManifest = {
      pricing: { 'mpp-session-ws': { min_deposit: '10.0' } },
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
})

// ---------------------------------------------------------------------------
// open_session endpoint resolution (issue #317)
// A bare origin must resolve to the manifest's streaming endpoint, because the
// SDK sends vouchers and the closing DELETE to the exact URL it is given.
// ---------------------------------------------------------------------------

describe('handleOpenSession endpoint resolution', () => {
  /** Deps whose fetchManifest serves `manifest` and whose client records the
   *  URL passed to openSession. */
  function resolutionDeps(manifest: unknown) {
    const manifestUrls: string[] = []
    const openedUrls: string[] = []
    const openSessions = new Map()
    const defaultClient = makeClient()
    const deps = baseDeps({
      openSessions,
      fetchManifest: async (url: string) => {
        manifestUrls.push(url)
        return { json: async () => manifest }
      },
      client: makeClient({
        openSession: async (url: string) => {
          openedUrls.push(url)
          return defaultClient.openSession(url)
        },
      }),
    })
    return { deps, manifestUrls, openedUrls, openSessions }
  }

  const STREAM_MANIFEST = {
    endpoints: { stream: { method: 'GET', path: '/stream/orderbook' } },
  }

  function errorText(result: ToolResult): string {
    return (parseResult(result) as { error: string }).error
  }

  it('resolves a bare origin to endpoints.stream', async () => {
    const { deps, manifestUrls, openedUrls } = resolutionDeps(STREAM_MANIFEST)
    const result = await handleOpenSession(
      { url: 'https://provider.example.com' },
      deps,
      'secret123',
    )
    assert.equal(result.isError, undefined)
    assert.deepEqual(openedUrls, ['https://provider.example.com/stream/orderbook'])
    assert.deepEqual(manifestUrls, ['https://provider.example.com/.well-known/routedock.json'])
    const body = parseResult(result) as { endpoint_url: string }
    assert.equal(body.endpoint_url, 'https://provider.example.com/stream/orderbook')
  })

  it('resolves an origin with a trailing slash the same way', async () => {
    const { deps, openedUrls } = resolutionDeps(STREAM_MANIFEST)
    const result = await handleOpenSession(
      { url: 'https://provider.example.com/' },
      deps,
      'secret123',
    )
    assert.equal(result.isError, undefined)
    assert.deepEqual(openedUrls, ['https://provider.example.com/stream/orderbook'])
  })

  it('falls back to the only endpoint when there is no stream key', async () => {
    const { deps, openedUrls } = resolutionDeps({
      endpoints: { feed: { method: 'GET', path: '/v1/feed' } },
    })
    const result = await handleOpenSession(
      { url: 'https://provider.example.com' },
      deps,
      'secret123',
    )
    assert.equal(result.isError, undefined)
    assert.deepEqual(openedUrls, ['https://provider.example.com/v1/feed'])
  })

  it('errors with every endpoint listed when several exist and none is stream', async () => {
    const { deps, openedUrls, openSessions } = resolutionDeps({
      endpoints: {
        price: { method: 'GET', path: '/price' },
        quote: { method: 'GET', path: '/quote' },
        orders: { method: 'POST', path: '/orders' },
      },
    })
    const result = await handleOpenSession(
      { url: 'https://provider.example.com' },
      deps,
      'secret123',
    )
    assert.equal(result.isError, true)
    const message = errorText(result)
    assert.ok(message.includes('https://provider.example.com'))
    for (const path of ['/price', '/quote', '/orders']) {
      assert.ok(message.includes(path), `error should list ${path}: ${message}`)
    }
    assert.deepEqual(openedUrls, [])
    assert.equal(openSessions.size, 0)
  })

  it('errors when the manifest lists no endpoints', async () => {
    const { deps, openedUrls } = resolutionDeps({ endpoints: {} })
    const result = await handleOpenSession(
      { url: 'https://provider.example.com' },
      deps,
      'secret123',
    )
    assert.equal(result.isError, true)
    assert.ok(errorText(result).includes('no endpoints'))
    assert.deepEqual(openedUrls, [])
  })

  it('errors when the chosen endpoint is not GET', async () => {
    const { deps, openedUrls } = resolutionDeps({
      endpoints: { stream: { method: 'POST', path: '/stream/orderbook' } },
    })
    const result = await handleOpenSession(
      { url: 'https://provider.example.com' },
      deps,
      'secret123',
    )
    assert.equal(result.isError, true)
    assert.ok(errorText(result).includes('/stream/orderbook'))
    assert.deepEqual(openedUrls, [])
  })

  for (const path of ['https://attacker.example/x', '//attacker.example/x']) {
    it(`refuses an endpoint path on another origin (${path})`, async () => {
      const { deps, openedUrls } = resolutionDeps({
        endpoints: { stream: { method: 'GET', path } },
      })
      const result = await handleOpenSession(
        { url: 'https://provider.example.com' },
        deps,
        'secret123',
      )
      assert.equal(result.isError, true)
      assert.deepEqual(openedUrls, [])
    })
  }

  it('passes a URL with a path through unchanged without fetching the manifest', async () => {
    const { deps, manifestUrls, openedUrls } = resolutionDeps(STREAM_MANIFEST)
    const result = await handleOpenSession(
      { url: 'https://provider.example.com/stream/orderbook' },
      deps,
      'secret123',
    )
    assert.equal(result.isError, undefined)
    assert.deepEqual(openedUrls, ['https://provider.example.com/stream/orderbook'])
    assert.equal(manifestUrls.length, 0)
    const body = parseResult(result) as { endpoint_url: string }
    assert.equal(body.endpoint_url, 'https://provider.example.com/stream/orderbook')
  })

  it('fetches the manifest once for a bare origin with initial_deposit', async () => {
    const { deps, manifestUrls, openedUrls } = resolutionDeps({
      ...STREAM_MANIFEST,
      pricing: { 'mpp-session': { min_deposit: '1.0' } },
    })
    const result = await handleOpenSession(
      { url: 'https://provider.example.com', initial_deposit: '5.0' },
      deps,
      'secret123',
    )
    assert.equal(result.isError, undefined)
    assert.equal(manifestUrls.length, 1)
    assert.deepEqual(openedUrls, ['https://provider.example.com/stream/orderbook'])
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

  it('pulls exactly 1 message when max_messages is omitted', async () => {
    const items = ['msg1', 'msg2', 'msg3']
    const fakeSession = makeStreamSession(items)
    const sessions = new Map<string, any>([['CHAN1', fakeSession]])
    const result = await handleStreamSession(
      { channel_id: 'CHAN1' },
      baseDeps({ openSessions: sessions }),
    )
    assert.equal(result.isError, undefined)
    const body = parseResult(result) as any
    assert.equal(body.count, 1)
    assert.deepEqual(body.messages, ['msg1'])
  })

  it('returns the paid prefix with stats when a later voucher fails', async () => {
    const stats = {
      vouchersIssued: 2,
      currentCumulative: '0.0002',
      channelId: 'CHAN1',
      openTxHash: null,
    }
    const items = ['msg1', 'msg2']
    let idx = 0
    const fakeSession = {
      stats: () => stats,
      stream: () => ({
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            if (idx >= items.length) {
              throw new Error('local_daily_cap_exceeded')
            }
            return { done: false, value: items[idx++] }
          },
        }),
      }),
    }
    const sessions = new Map<string, any>([['CHAN1', fakeSession]])
    const result = await handleStreamSession(
      { channel_id: 'CHAN1', max_messages: 5 },
      baseDeps({ openSessions: sessions }),
    )
    assert.equal(result.isError, true)
    const body = parseResult(result) as any
    assert.equal(body.success, false)
    assert.ok(body.error.includes('local_daily_cap_exceeded'))
    assert.equal(body.channel_id, 'CHAN1')
    assert.equal(body.count, 2)
    assert.deepEqual(body.messages, ['msg1', 'msg2'])
    assert.deepEqual(body.stats, stats)
  })

  it('resolves with an empty partial batch when the first voucher fails', async () => {
    const stats = { vouchersIssued: 0, currentCumulative: '0', channelId: 'CHAN1', openTxHash: null }
    const fakeSession = {
      stats: () => stats,
      stream: () => ({
        [Symbol.asyncIterator]: () => ({
          next: async () => {
            throw new Error('Voucher request failed: HTTP 500')
          },
        }),
      }),
    }
    const sessions = new Map<string, any>([['CHAN1', fakeSession]])
    const result = await handleStreamSession(
      { channel_id: 'CHAN1', max_messages: 5 },
      baseDeps({ openSessions: sessions }),
    )
    assert.equal(result.isError, true)
    const body = parseResult(result) as any
    assert.equal(body.count, 0)
    assert.deepEqual(body.messages, [])
  })

  it('closes the generator with return() on the normal path', async () => {
    let returnCalls = 0
    const items = ['msg1', 'msg2', 'msg3']
    let idx = 0
    const iterator = {
      next: async () =>
        idx < items.length
          ? { done: false, value: items[idx++] }
          : { done: true, value: undefined },
      return: async () => {
        returnCalls++
        return { done: true, value: undefined }
      },
    }
    const fakeSession = { stream: () => ({ [Symbol.asyncIterator]: () => iterator }) }
    const sessions = new Map<string, any>([['CHAN1', fakeSession]])
    await handleStreamSession(
      { channel_id: 'CHAN1', max_messages: 2 },
      baseDeps({ openSessions: sessions }),
    )
    assert.equal(returnCalls, 1)
  })

  it('closes the generator with return() on the error path', async () => {
    let returnCalls = 0
    const iterator = {
      next: async () => {
        throw new Error('local_daily_cap_exceeded')
      },
      return: async () => {
        returnCalls++
        return { done: true, value: undefined }
      },
    }
    const fakeSession = {
      stats: () => ({ vouchersIssued: 0, currentCumulative: '0', channelId: 'CHAN1', openTxHash: null }),
      stream: () => ({ [Symbol.asyncIterator]: () => iterator }),
    }
    const sessions = new Map<string, any>([['CHAN1', fakeSession]])
    await handleStreamSession(
      { channel_id: 'CHAN1', max_messages: 3 },
      baseDeps({ openSessions: sessions }),
    )
    assert.equal(returnCalls, 1)
  })

  it('still works with a generator that has no return() method', async () => {
    const items = ['msg1']
    const fakeSession = makeStreamSession(items)
    const sessions = new Map<string, any>([['CHAN1', fakeSession]])
    const result = await handleStreamSession(
      { channel_id: 'CHAN1', max_messages: 1 },
      baseDeps({ openSessions: sessions }),
    )
    assert.equal(result.isError, undefined)
  })

  for (const invalid of [0, -1, 2.5, 51]) {
    it(`rejects invalid max_messages ${invalid} without calling stream()`, async () => {
      let streamCalls = 0
      const fakeSession = {
        stats: () => ({}),
        stream: () => {
          streamCalls++
          return { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }) }
        },
      }
      const sessions = new Map<string, any>([['CHAN1', fakeSession]])
      const result = await handleStreamSession(
        { channel_id: 'CHAN1', max_messages: invalid },
        baseDeps({ openSessions: sessions }),
      )
      assert.equal(result.isError, true)
      const body = parseResult(result) as any
      assert.ok(body.error.includes('1 and 50'))
      assert.equal(streamCalls, 0)
    })
  }

  it('accepts max_messages at the upper bound of 50', async () => {
    const items = ['msg1', 'msg2']
    const fakeSession = makeStreamSession(items)
    const sessions = new Map<string, any>([['CHAN1', fakeSession]])
    const result = await handleStreamSession(
      { channel_id: 'CHAN1', max_messages: 50 },
      baseDeps({ openSessions: sessions }),
    )
    assert.equal(result.isError, undefined)
    const body = parseResult(result) as any
    assert.equal(body.count, 2)
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

  /** Typed view of a check_balance payload, so these assertions stay off `any`. */
  function balancePayload(result: ToolResult): Record<string, unknown> {
    return JSON.parse(result.content[0]!.text) as Record<string, unknown>
  }

  it('returns the canonical USDC balance when only asset_code is given', async () => {
    // #given an account holding USDC from Circle, this server's network
    const deps = baseDeps({
      stellarSecret: secret,
      createHorizonServer: makeHorizon([
        { asset_code: 'USDC', asset_issuer: USDC_ISSUERS.testnet, balance: '100.00' },
      ]),
    })

    // #when asking for the asset by code alone
    const result = await handleCheckBalance({ asset_code: 'USDC' }, deps)
    const body = balancePayload(result)

    assert.equal(body.asset, 'USDC')
    assert.equal(body.balance, '100.00')
    assert.equal(body.issuer, USDC_ISSUERS.testnet)
  })

  it('ignores a same-coded USDC issued by someone else (issue #567)', async () => {
    // #given a lookalike USDC listed before the real one, as Horizon may return
    const deps = baseDeps({
      stellarSecret: secret,
      createHorizonServer: makeHorizon([
        { asset_code: 'USDC', asset_issuer: 'GDV4RBI44MPBORVOUHDVH34IKYHKGAVHVJFDGZ4BQ2FOCBNLNQIHSB6O', balance: '999999.00' },
        { asset_code: 'USDC', asset_issuer: USDC_ISSUERS.testnet, balance: '100.00' },
      ]),
    })

    // #when asking for USDC without naming an issuer
    const body = balancePayload(await handleCheckBalance({ asset_code: 'USDC' }, deps))

    // #then the canonical issuer's balance is reported, not the lookalike's
    assert.equal(body.balance, '100.00')
    assert.equal(body.issuer, USDC_ISSUERS.testnet)
    assert.ok(
      typeof body.note === 'string' && body.note.includes('asset_issuer'),
      'the answer must say the issuer was defaulted',
    )
  })

  it('returns 0 for USDC when the account only holds a lookalike', async () => {
    const deps = baseDeps({
      stellarSecret: secret,
      createHorizonServer: makeHorizon([
        { asset_code: 'USDC', asset_issuer: 'GDV4RBI44MPBORVOUHDVH34IKYHKGAVHVJFDGZ4BQ2FOCBNLNQIHSB6O', balance: '999999.00' },
      ]),
    })
    const body = balancePayload(await handleCheckBalance({ asset_code: 'USDC' }, deps))

    assert.equal(body.balance, '0')
    assert.equal(body.issuer, USDC_ISSUERS.testnet)
  })

  it('defaults USDC to the mainnet issuer on a mainnet server', async () => {
    const deps = baseDeps({
      stellarSecret: secret,
      stellarNetwork: 'mainnet',
      createHorizonServer: makeHorizon([
        { asset_code: 'USDC', asset_issuer: USDC_ISSUERS.testnet, balance: '10.00' },
        { asset_code: 'USDC', asset_issuer: USDC_ISSUERS.mainnet, balance: '250.00' },
      ]),
    })
    const body = balancePayload(await handleCheckBalance({ asset_code: 'USDC' }, deps))

    assert.equal(body.balance, '250.00')
    assert.equal(body.issuer, USDC_ISSUERS.mainnet)
  })

  it('returns every issuer when a non-USDC code is ambiguous (issue #567)', async () => {
    // #given two unrelated assets that both use the code USD1
    const deps = baseDeps({
      stellarSecret: secret,
      createHorizonServer: makeHorizon([
        { asset_code: 'USD1', asset_issuer: 'ISSUER1', balance: '10.00' },
        { asset_code: 'USD1', asset_issuer: 'ISSUER2', balance: '20.00' },
      ]),
    })

    // #when asking for the code with no issuer
    const body = balancePayload(await handleCheckBalance({ asset_code: 'USD1' }, deps))

    // #then nothing is silently picked: both are shown, each with its issuer
    assert.equal(body.ambiguous, true)
    assert.deepEqual(body.issuers, [
      { issuer: 'ISSUER1', balance: '10.00' },
      { issuer: 'ISSUER2', balance: '20.00' },
    ])
    assert.equal(body.balance, undefined)
  })

  it('returns the single issuer when a non-USDC code is unambiguous', async () => {
    const deps = baseDeps({
      stellarSecret: secret,
      createHorizonServer: makeHorizon([
        { asset_code: 'USD1', asset_issuer: 'ISSUER1', balance: '10.00' },
      ]),
    })
    const body = balancePayload(await handleCheckBalance({ asset_code: 'USD1' }, deps))

    assert.equal(body.ambiguous, undefined)
    assert.equal(body.issuer, 'ISSUER1')
    assert.equal(body.balance, '10.00')
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
    // An explicit issuer stays exact — including for a non-canonical USDC, which
    // is the only way to read a lookalike balance on purpose.
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
    const body = balancePayload(result)

    assert.equal(body.balance, '55.50')
    assert.equal(body.issuer, 'ISSUER1')
    assert.equal(body.note, undefined)
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

  it('defaults the network filter to the server network (issue #566)', async () => {
    // #given a testnet server and an empty registry
    const calls = newSupabaseCalls()
    const deps = baseDeps({ stellarNetwork: 'testnet', supabase: makeSupabase([], null, calls) })

    // #when listing providers without a network argument
    const result = await handleListProviders({}, deps)

    // #then only that network is queried, and the answer says so
    assert.deepEqual(calls.eq, [['network', 'testnet']])
    assert.equal(payload(result).network, 'testnet')
  })

  it('defaults the network filter to mainnet on a mainnet server', async () => {
    const calls = newSupabaseCalls()
    const deps = baseDeps({ stellarNetwork: 'mainnet', supabase: makeSupabase([], null, calls) })
    await handleListProviders({}, deps)
    assert.deepEqual(calls.eq, [['network', 'mainnet']])
  })

  it('honours an explicit network over the server default', async () => {
    const calls = newSupabaseCalls()
    const deps = baseDeps({ stellarNetwork: 'testnet', supabase: makeSupabase([], null, calls) })
    const result = await handleListProviders({ network: 'mainnet' }, deps)
    assert.deepEqual(calls.eq, [['network', 'mainnet']])
    assert.equal(payload(result).network, 'mainnet')
  })

  it('selects explicit columns instead of the whole table', async () => {
    const calls = newSupabaseCalls()
    const deps = baseDeps({ supabase: makeSupabase([], null, calls) })
    await handleListProviders({}, deps)

    assert.ok(!calls.select.includes('*'), `select must not use '*', got ${calls.select}`)
    assert.ok(calls.select.includes('verified'), 'verified has to be selected to be returned')
    assert.ok(calls.select.includes('manifest->asset'), 'assets live in the manifest JSONB')
  })

  it('bounds the query to MAX_PROVIDER_ROWS when no limit is given', async () => {
    const calls = newSupabaseCalls()
    const deps = baseDeps({ supabase: makeSupabase([], null, calls) })
    const result = await handleListProviders({}, deps)

    assert.deepEqual(calls.limit, [MAX_PROVIDER_ROWS])
    assert.equal(payload(result).limit, MAX_PROVIDER_ROWS)
  })

  it('honours a caller-supplied limit', async () => {
    const calls = newSupabaseCalls()
    const deps = baseDeps({ supabase: makeSupabase([], null, calls) })
    const result = await handleListProviders({ limit: 5 }, deps)

    assert.deepEqual(calls.limit, [5])
    assert.equal(payload(result).limit, 5)
  })

  it('rejects a limit outside 1..MAX_PROVIDER_ROWS without querying', async () => {
    for (const limit of [0, -1, 1.5, MAX_PROVIDER_ROWS + 1]) {
      const calls = newSupabaseCalls()
      const deps = baseDeps({ supabase: makeSupabase([], null, calls) })
      const result = await handleListProviders({ limit }, deps)

      assert.equal(result.isError, true, `limit ${limit} must be rejected`)
      assert.equal(calls.select, '', `limit ${limit} must not reach the database`)
    }
  })

  it('orders verified providers first, newest registration second', async () => {
    const calls = newSupabaseCalls()
    const deps = baseDeps({ supabase: makeSupabase([], null, calls) })
    await handleListProviders({}, deps)

    assert.deepEqual(calls.order, [
      ['verified', { ascending: false }],
      ['registered_at', { ascending: false }],
    ])
  })

  it('returns the real assets and the verified flag instead of asset: undefined', async () => {
    // #given a row shaped like the registry query: PostgREST projects
    // manifest->asset onto a top-level key, and `verified` is a real column
    const rows = [
      {
        name: 'ProvA',
        description: 'desc',
        network: 'testnet',
        base_url: 'https://a.example.com',
        modes: ['x402'],
        tags: ['price'],
        verified: true,
        asset: 'USDC',
      },
    ]
    const deps = baseDeps({ supabase: makeSupabase(rows) })

    // #when listing providers
    const provider = firstProvider(await handleListProviders({}, deps))

    // #then the advertised asset and verification state are visible
    assert.deepEqual(provider.assets, ['USDC'])
    assert.equal(provider.asset, 'USDC')
    assert.equal(provider.verified, true)
  })

  it('reads multi-asset providers from the manifest column', async () => {
    // A manifest's `assets` is an AssetConfig[] (asset / asset_contract /
    // modes), not a list of codes, so this is what PostgREST projects.
    const rows = [
      {
        name: 'ProvC',
        description: '',
        network: 'testnet',
        base_url: 'https://c.example.com',
        modes: ['mpp-charge'],
        tags: [],
        verified: false,
        manifest: {
          assets: [
            { asset: 'USDC', asset_contract: 'C...', modes: ['x402'] },
            { asset: 'EURC', asset_contract: 'C...', modes: ['x402'] },
          ],
        },
      },
    ]
    const deps = baseDeps({ supabase: makeSupabase(rows) })
    const result = await handleListProviders({}, deps)

    const provider = firstProvider(result)
    assert.deepEqual(provider.assets, ['USDC', 'EURC'])
    assert.equal(provider.asset, 'USDC')
    assert.equal(provider.verified, false)
  })

  it('marks the result truncated only when the row cap is reached', async () => {
    const rows = Array.from({ length: 2 }, (_unused, i) => ({
      name: `Prov${i}`,
      description: '',
      network: 'testnet',
      base_url: `https://${i}.example.com`,
      modes: ['x402'],
      tags: [],
      verified: false,
      asset: 'USDC',
    }))
    const deps = baseDeps({ supabase: makeSupabase(rows) })

    const partial = payload(await handleListProviders({ limit: 3 }, deps))
    assert.equal(partial.truncated, false)

    const capped = payload(await handleListProviders({ limit: 2 }, deps))
    assert.equal(capped.truncated, true)
  })
})
