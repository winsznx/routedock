import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Horizon } from '@stellar/stellar-sdk'
import { OnChainRegistry } from '../OnChainRegistry.js'
import { ProviderRegistry } from '../ProviderRegistry.js'
import type { RouteDockLogger } from '../../internal/logger.js'

// ---------------------------------------------------------------------------
// OnChainRegistry helpers
// ---------------------------------------------------------------------------

function toBase64(value: string): string {
  return typeof Buffer !== 'undefined'
    ? Buffer.from(value, 'utf-8').toString('base64')
    : btoa(value)
}

function makeHorizonMock(
  accounts: Record<string, { routedock_endpoint?: string; routedock_tags?: string } | null>,
) {
  return {
    loadAccount: async (accountId: string) => {
      const entry = accounts[accountId]
      if (entry === null) throw new Error(`Account ${accountId} not found`)
      return { data_attr: entry }
    },
  }
}

// Override the internal Horizon.Server construction by monkey-patching the module —
// since OnChainRegistry accepts a horizonUrl we use a factory helper instead.
// We test via a subclass that accepts an injected horizon mock.
class TestOnChainRegistry extends OnChainRegistry {
  constructor(mockHorizon: ReturnType<typeof makeHorizonMock>, knownAccounts: string[]) {
    super({ horizonUrl: 'https://horizon-testnet.stellar.org', knownAccounts })
    // @ts-expect-error — override private field for testing
    this.horizon = mockHorizon as any
  }
}

// ---------------------------------------------------------------------------
// OnChainRegistry Tests
// ---------------------------------------------------------------------------

describe('OnChainRegistry.listProviders — endpoint decoding', () => {
  it('decodes a base64-encoded endpoint URL', async () => {
    const url = 'https://provider.example.com'
    const registry = new TestOnChainRegistry(
      makeHorizonMock({ ACCT1: { routedock_endpoint: toBase64(url) } }),
      ['ACCT1'],
    )
    const providers = await registry.listProviders()
    assert.equal(providers.length, 1)
    assert.equal(providers[0]!.endpoint, url)
    assert.equal(providers[0]!.account, 'ACCT1')
  })

  it('returns a plain URL as-is without decoding', async () => {
    const url = 'https://plain-url.example.com'
    const registry = new TestOnChainRegistry(
      makeHorizonMock({ ACCT2: { routedock_endpoint: url } }),
      ['ACCT2'],
    )
    const providers = await registry.listProviders()
    assert.equal(providers.length, 1)
    assert.equal(providers[0]!.endpoint, url)
  })

  it('filters out non-http endpoints', async () => {
    const registry = new TestOnChainRegistry(
      makeHorizonMock({ ACCT3: { routedock_endpoint: 'ftp://bad-endpoint.com' } }),
      ['ACCT3'],
    )
    const providers = await registry.listProviders()
    assert.equal(providers.length, 0)
  })

  it('skips accounts with no routedock_endpoint entry', async () => {
    const registry = new TestOnChainRegistry(
      makeHorizonMock({ ACCT4: {} }),
      ['ACCT4'],
    )
    const providers = await registry.listProviders()
    assert.equal(providers.length, 0)
  })

  it('swallows Horizon load failures gracefully', async () => {
    const registry = new TestOnChainRegistry(
      makeHorizonMock({ ACCT5: null }),
      ['ACCT5'],
    )
    const providers = await registry.listProviders()
    assert.equal(providers.length, 0)
  })
})

describe('OnChainRegistry.listProviders — tag decoding', () => {
  it('parses a JSON array of tags', async () => {
    const tags = JSON.stringify(['ai', 'stellar', 'dex'])
    const registry = new TestOnChainRegistry(
      makeHorizonMock({
        ACCT6: {
          routedock_endpoint: 'https://provider.example.com',
          routedock_tags: toBase64(tags),
        },
      }),
      ['ACCT6'],
    )
    const providers = await registry.listProviders()
    assert.deepEqual(providers[0]!.tags, ['ai', 'stellar', 'dex'])
  })

  it('falls back to CSV-split when tags are not valid JSON', async () => {
    // In production, Stellar data_attr values are base64-encoded.
    // Encode the CSV string so tryDecodeBase64 returns the raw CSV,
    // JSON.parse fails, and the code falls back to split(',').
    const registry = new TestOnChainRegistry(
      makeHorizonMock({
        ACCT7: {
          routedock_endpoint: 'https://provider.example.com',
          routedock_tags: toBase64('ai,stellar,dex'),
        },
      }),
      ['ACCT7'],
    )
    const providers = await registry.listProviders()
    assert.deepEqual(providers[0]!.tags, ['ai', 'stellar', 'dex'])
  })

  it('returns empty tags when no routedock_tags entry', async () => {
    const registry = new TestOnChainRegistry(
      makeHorizonMock({
        ACCT8: { routedock_endpoint: 'https://provider.example.com' },
      }),
      ['ACCT8'],
    )
    const providers = await registry.listProviders()
    assert.deepEqual(providers[0]!.tags, [])
  })
})

describe('OnChainRegistry.listProviders — multi-account', () => {
  it('returns providers for all valid accounts', async () => {
    const registry = new TestOnChainRegistry(
      makeHorizonMock({
        ACCT9: { routedock_endpoint: 'https://a.example.com' },
        ACCT10: { routedock_endpoint: 'https://b.example.com' },
        ACCT11: null, // fails to load
      }),
      ['ACCT9', 'ACCT10', 'ACCT11'],
    )
    const providers = await registry.listProviders()
    assert.equal(providers.length, 2)
  })
})

// ---------------------------------------------------------------------------
// OnChainRegistry Tests — timeout and concurrency
// ---------------------------------------------------------------------------

/** A Horizon that accepts the connection and never answers. */
function stalled(): Promise<never> {
  return new Promise<never>(() => {})
}

function fakeAccount(endpoint: string) {
  return { data_attr: { routedock_endpoint: endpoint } }
}

describe('OnChainRegistry.listProviders — timeout', () => {
  it(
    'resolves to [] within the timeout budget when the only account stalls',
    { timeout: 5000 },
    async (t) => {
      // #given a Horizon that never answers
      t.mock.method(Horizon.Server.prototype, 'loadAccount', () => stalled())
      const registry = new OnChainRegistry({
        horizonUrl: 'https://horizon-testnet.stellar.org',
        knownAccounts: ['SLOW'],
        timeoutMs: 50,
      })

      // #when
      const started = Date.now()
      const providers = await registry.listProviders()
      const elapsed = Date.now() - started

      // #then
      assert.deepEqual(providers, [])
      assert.ok(elapsed < 1000, `expected < 1000ms, took ${elapsed}ms`)
    },
  )

  it(
    'returns the healthy account when another account stalls',
    { timeout: 5000 },
    async (t) => {
      // #given one stalled account and one healthy account
      t.mock.method(Horizon.Server.prototype, 'loadAccount', (accountId: string) =>
        accountId === 'SLOW' ? stalled() : Promise.resolve(fakeAccount('https://healthy.example.com')),
      )
      const registry = new OnChainRegistry({
        horizonUrl: 'https://horizon-testnet.stellar.org',
        knownAccounts: ['SLOW', 'HEALTHY'],
        timeoutMs: 50,
      })

      // #when
      const providers = await registry.listProviders()

      // #then
      assert.equal(providers.length, 1)
      assert.equal(providers[0]!.account, 'HEALTHY')
      assert.equal(providers[0]!.endpoint, 'https://healthy.example.com')
    },
  )

  it(
    'times out three stalled accounts in a single concurrent window',
    { timeout: 5000 },
    async (t) => {
      // #given three accounts that all stall
      t.mock.method(Horizon.Server.prototype, 'loadAccount', () => stalled())
      const registry = new OnChainRegistry({
        horizonUrl: 'https://horizon-testnet.stellar.org',
        knownAccounts: ['S1', 'S2', 'S3'],
        timeoutMs: 300,
      })

      // #when
      const started = Date.now()
      const providers = await registry.listProviders()
      const elapsed = Date.now() - started

      // #then — a sequential loop would need at least 900ms
      assert.deepEqual(providers, [])
      assert.ok(elapsed < 700, `expected concurrent loads (< 700ms), took ${elapsed}ms`)
    },
  )

  it(
    'returns results in knownAccounts order even when loads finish out of order',
    { timeout: 5000 },
    async (t) => {
      // #given the first account is the slowest to answer
      t.mock.method(Horizon.Server.prototype, 'loadAccount', async (accountId: string) => {
        if (accountId === 'A') await new Promise((resolve) => setTimeout(resolve, 30))
        return fakeAccount(`https://${accountId.toLowerCase()}.example.com`)
      })
      const registry = new OnChainRegistry({
        horizonUrl: 'https://horizon-testnet.stellar.org',
        knownAccounts: ['A', 'B', 'C'],
        timeoutMs: 1000,
      })

      // #when
      const providers = await registry.listProviders()

      // #then
      assert.deepEqual(
        providers.map((p) => p.account),
        ['A', 'B', 'C'],
      )
    },
  )
})

// ---------------------------------------------------------------------------
// ProviderRegistry helpers
// ---------------------------------------------------------------------------

function makeSupabaseMock(
  rows: object[] | null,
  error: object | null = null,
  calls: { order?: string | undefined; limit?: number | undefined } = {},
  throws?: Error,
) {
  return {
    from: () => {
      const filters: Record<string, unknown> = {}
      return {
        // Mirrors the real query:
        // .select('*').eq('verified', true).eq('network', ...).order('registered_at').limit(n)
        select: () => {
          let orderColumn: string | undefined
          let overlapTags: string[] | undefined
          const query = {
            overlaps: (_column: string, values: string[]) => {
              overlapTags = values
              return query
            },
            eq: (column: string, value: unknown) => {
              filters[column] = value
              return query
            },
            order: (column: string) => {
              orderColumn = column
              return query
            },
            limit: (n: number) => {
              calls.order = orderColumn
              calls.limit = n
              if (throws) return Promise.reject(throws)
              const filtered = error
                ? null
                : rows
                  ? rows.filter(
                      (r) =>
                        Object.entries(filters).every(
                          ([column, value]) => (r as Record<string, unknown>)[column] === value,
                        ) &&
                        (!overlapTags ||
                          ((r as { tags?: string[] }).tags ?? []).some((t) => overlapTags!.includes(t))),
                    )
                  : rows
              const data =
                filtered && orderColumn
                  ? [...filtered].sort((a, b) =>
                      String((a as Record<string, unknown>)[orderColumn!]).localeCompare(
                        String((b as Record<string, unknown>)[orderColumn!]),
                      ),
                    )
                  : filtered
              return Promise.resolve({ data: data ? data.slice(0, n) : data, error })
            },
          }
          return query
        },
      }
    },
  } as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['supabase']
}

class TestProviderRegistry extends ProviderRegistry {
  constructor(
    supabase: ReturnType<typeof makeSupabaseMock> | undefined,
    mockHorizon: ReturnType<typeof makeHorizonMock>,
    network?: 'testnet' | 'mainnet',
    extra: { logger?: RouteDockLogger; limit?: number } = {},
  ) {
    super({
      ...(supabase ? { supabase: supabase as any } : {}),
      ...extra,
      onChain: {
        horizonUrl: 'https://horizon-testnet.stellar.org',
        knownAccounts: ['ACCT9'],
        ...(network ? { network } : {}),
      },
    })
    // @ts-expect-error — override private field for testing
    this.onChain = new TestOnChainRegistry(mockHorizon, ['ACCT9'])
  }
}

const emptyOnChain = makeHorizonMock({
  ACCT9: null,
})
const oneOnChain = makeHorizonMock({
  ACCT9: { routedock_endpoint: 'https://onchain.example.com' },
})

// ---------------------------------------------------------------------------
// ProviderRegistry Tests
// ---------------------------------------------------------------------------

describe('ProviderRegistry.listProviders — Supabase primary', () => {
  it('returns mapped ProviderRecord[] from Supabase', async () => {
    const rows = [
      {
        name: 'Provider A',
        description: 'A test provider',
        base_url: 'https://a.example.com',
        modes: ['x402'],
        tags: ['ai'],
        network: 'testnet',
        payee: 'GPAYEE1',
        manifest: {},
        verified: true,
        registered_at: new Date().toISOString(),
      },
    ]
    const registry = new TestProviderRegistry(makeSupabaseMock(rows), emptyOnChain)
    const providers = await registry.listProviders()
    assert.equal(providers.length, 1)
    assert.equal(providers[0]!.name, 'Provider A')
    assert.equal(providers[0]!.source, 'supabase')
  })
})

describe('ProviderRegistry.listProviders — on-chain fallback', () => {
  it('falls back to on-chain when Supabase returns empty', async () => {
    const registry = new TestProviderRegistry(makeSupabaseMock([]), oneOnChain)
    const providers = await registry.listProviders()
    assert.equal(providers.length, 1)
    assert.equal(providers[0]!.source, 'onchain')
  })

  it('falls back to on-chain when Supabase returns an error', async () => {
    const registry = new TestProviderRegistry(
      makeSupabaseMock(null, { message: 'Connection refused' }),
      oneOnChain,
    )
    const providers = await registry.listProviders()
    assert.equal(providers.length, 1)
    assert.equal(providers[0]!.source, 'onchain')
  })

  it('goes straight to on-chain when no Supabase configured', async () => {
    const registry = new TestProviderRegistry(undefined, oneOnChain)
    const providers = await registry.listProviders()
    assert.equal(providers.length, 1)
    assert.equal(providers[0]!.source, 'onchain')
  })

  it(
    'forwards onChain.timeoutMs so listProviders resolves when Horizon stalls',
    { timeout: 5000 },
    async (t) => {
      // #given a stalled Horizon and a registry configured with a 50ms timeout
      t.mock.method(Horizon.Server.prototype, 'loadAccount', () => stalled())
      const registry = new ProviderRegistry({
        onChain: {
          horizonUrl: 'https://horizon-testnet.stellar.org',
          knownAccounts: ['SLOW'],
          timeoutMs: 50,
        },
      })

      // #when
      const started = Date.now()
      const providers = await registry.listProviders()
      const elapsed = Date.now() - started

      // #then
      assert.deepEqual(providers, [])
      assert.ok(elapsed < 1000, `expected < 1000ms, took ${elapsed}ms`)
    },
  )
})

// ---------------------------------------------------------------------------
// Network filtering
// ---------------------------------------------------------------------------

function makeRow(network: 'testnet' | 'mainnet', name: string): object {
  return {
    id: `${name}-id`,
    name,
    description: `${name} description`,
    base_url: `https://${name.toLowerCase()}.example.com`,
    modes: ['x402'],
    tags: [network],
    network,
    payee: `GPAYEE-${network}`,
    manifest: {},
    verified: true,
    registered_at: new Date().toISOString(),
  }
}

describe('ProviderRegistry.listProviders — network filtering', () => {
  it('returns only rows matching the configured network when both networks are present', async () => {
    const mainnetRow = makeRow('mainnet', 'Mainnet Provider')
    const testnetRow = makeRow('testnet', 'Testnet Provider')
    const rows = [mainnetRow, testnetRow]

    const mainnetRegistry = new TestProviderRegistry(
      makeSupabaseMock(rows),
      emptyOnChain,
      'mainnet',
    )
    const mainnetProviders = await mainnetRegistry.listProviders()
    assert.equal(mainnetProviders.length, 1)
    assert.equal(mainnetProviders[0]!.network, 'mainnet')
    assert.equal(mainnetProviders[0]!.name, 'Mainnet Provider')

    const testnetRegistry = new TestProviderRegistry(
      makeSupabaseMock(rows),
      emptyOnChain,
      'testnet',
    )
    const testnetProviders = await testnetRegistry.listProviders()
    assert.equal(testnetProviders.length, 1)
    assert.equal(testnetProviders[0]!.network, 'testnet')
    assert.equal(testnetProviders[0]!.name, 'Testnet Provider')
  })

  it('falls through to on-chain when Supabase only holds rows for the other network', async () => {
    const testnetRow = makeRow('testnet', 'Testnet Provider')
    const registry = new TestProviderRegistry(
      makeSupabaseMock([testnetRow]),
      oneOnChain,
      'mainnet',
    )
    const providers = await registry.listProviders()
    assert.equal(providers.length, 1)
    assert.equal(providers[0]!.source, 'onchain')
    assert.equal(providers[0]!.network, 'mainnet')
  })
})

// ---------------------------------------------------------------------------
// Merge, ordering, logging, tags (#762)
// ---------------------------------------------------------------------------

describe('ProviderRegistry.listProviders — merged sources (#762)', () => {
  it('returns the Supabase row and the on-chain account together', async () => {
    const registry = new TestProviderRegistry(
      makeSupabaseMock([makeRow('testnet', 'Listed')]),
      oneOnChain,
    )
    const providers = await registry.listProviders()
    assert.deepEqual(
      providers.map((p) => [p.name, p.source]).sort(),
      [
        ['Listed', 'supabase'],
        ['On-chain provider (ACCT9...)', 'onchain'],
      ],
    )
  })

  it('merges by normalized origin with Supabase metadata winning', async () => {
    const row = { ...makeRow('testnet', 'Listed'), base_url: 'https://Onchain.Example.com/' }
    const registry = new TestProviderRegistry(makeSupabaseMock([row]), oneOnChain)
    const providers = await registry.listProviders()
    assert.equal(providers.length, 1)
    assert.equal(providers[0]!.source, 'supabase')
    assert.equal(providers[0]!.name, 'Listed')
  })

  it('orders Supabase by registered_at and passes the configured limit', async () => {
    const calls: { order?: string | undefined; limit?: number | undefined } = {}
    const older = { ...makeRow('testnet', 'Older'), registered_at: '2026-01-01T00:00:00Z' }
    const newer = { ...makeRow('testnet', 'Newer'), registered_at: '2026-06-01T00:00:00Z' }
    const registry = new TestProviderRegistry(
      makeSupabaseMock([newer, older], null, calls),
      emptyOnChain,
      undefined,
      { limit: 1 },
    )
    const providers = await registry.listProviders()
    assert.equal(calls.order, 'registered_at')
    assert.equal(calls.limit, 1)
    assert.deepEqual(providers.map((p) => p.name), ['Older'], 'stable subset: oldest registrations first')
  })

  it('reports a Supabase error through the logger and still returns on-chain providers', async () => {
    const logs: Array<[string, string, unknown]> = []
    const logger: RouteDockLogger = (level, message, fields) => void logs.push([level, message, fields])
    const registry = new TestProviderRegistry(
      makeSupabaseMock(null, { message: 'permission denied for table providers' }),
      oneOnChain,
      undefined,
      { logger },
    )
    const providers = await registry.listProviders()
    assert.deepEqual(providers.map((p) => p.source), ['onchain'])
    assert.equal(logs.length, 1)
    assert.equal(logs[0]![0], 'warn')
    assert.match(JSON.stringify(logs[0]![2]), /permission denied/)
  })

  it('reports a thrown Supabase exception through the logger', async () => {
    const logs: Array<[string, string, unknown]> = []
    const logger: RouteDockLogger = (level, message, fields) => void logs.push([level, message, fields])
    const registry = new TestProviderRegistry(
      makeSupabaseMock([], null, {}, new Error('fetch failed')),
      oneOnChain,
      undefined,
      { logger },
    )
    assert.equal((await registry.listProviders()).length, 1)
    assert.equal(logs.length, 1)
    assert.equal((logs[0]![2] as { error: Error }).error.message, 'fetch failed')
  })

  it('rejects a non-positive limit', () => {
    assert.throws(
      () => new ProviderRegistry({ limit: 0, onChain: { horizonUrl: 'https://horizon-testnet.stellar.org', knownAccounts: [] } }),
      /limit must be a positive integer/,
    )
  })
})

describe('OnChainRegistry — tag validation (#762)', () => {
  it('drops non-string entries from a JSON tag array', async () => {
    const horizon = makeHorizonMock({
      A: { routedock_endpoint: 'https://a.example.com', routedock_tags: JSON.stringify(['ai', 1, null, { x: 1 }, 'dex']) },
    })
    const [provider] = await new TestOnChainRegistry(horizon, ['A']).listProviders()
    assert.deepEqual(provider!.tags, ['ai', 'dex'])
  })
})


// ---------------------------------------------------------------------------
// listProviders options: unverified rows and tag filter (issue #762 review)
// ---------------------------------------------------------------------------

describe('ProviderRegistry.listProviders options', () => {
  const row = (name: string, verified: boolean, tags: string[], extra: object = {}) => ({
    id: name,
    name,
    description: null,
    base_url: `https://${name}.example.com`,
    modes: ['x402'],
    tags,
    network: 'testnet',
    payee: `G${name.toUpperCase()}`,
    manifest: null,
    verified,
    registered_at: '2025-01-01T00:00:00Z',
    last_seen_at: '2025-01-01T00:00:00Z',
    ...extra,
  })
  const noOnChain = makeHorizonMock({ ACCT9: null })

  it('hides unverified rows by default', async () => {
    const rows = [row('a', true, ['x']), row('b', false, ['x'])]
    const registry = new TestProviderRegistry(makeSupabaseMock(rows), noOnChain)
    assert.deepEqual((await registry.listProviders()).map((r) => r.name), ['a'])
  })

  it('includeUnverified returns them flagged verified:false', async () => {
    const rows = [row('a', true, ['x']), row('b', false, ['x'])]
    const registry = new TestProviderRegistry(makeSupabaseMock(rows), noOnChain)
    const listed = await registry.listProviders({ includeUnverified: true })
    assert.deepEqual(
      listed.map((r) => [r.name, r.verified]).sort(),
      [['a', true], ['b', false]],
    )
  })

  it('includeUnverified orders by last_seen_at', async () => {
    const calls: { order?: string | undefined } = {}
    const registry = new TestProviderRegistry(makeSupabaseMock([row('a', true, [])], null, calls), noOnChain)
    await registry.listProviders({ includeUnverified: true })
    assert.equal(calls.order, 'last_seen_at')
  })

  it('applies the tag filter in the query, before the row limit', async () => {
    const rows = [
      row('a', true, ['other'], { registered_at: '2025-01-01T00:00:00Z' }),
      row('b', true, ['other'], { registered_at: '2025-01-02T00:00:00Z' }),
      row('c', true, ['wanted'], { registered_at: '2025-01-03T00:00:00Z' }),
    ]
    const registry = new TestProviderRegistry(makeSupabaseMock(rows), noOnChain, undefined, { limit: 2 })
    const listed = await registry.listProviders({ tags: ['wanted'] })
    assert.deepEqual(listed.map((r) => r.name), ['c'])
  })
})
