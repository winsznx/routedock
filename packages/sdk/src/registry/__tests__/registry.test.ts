import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { OnChainRegistry } from '../OnChainRegistry.js'
import { ProviderRegistry } from '../ProviderRegistry.js'

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
// ProviderRegistry helpers
// ---------------------------------------------------------------------------

function makeSupabaseMock(rows: object[] | null, error: object | null = null) {
  return {
    from: () => {
      const filters: Record<string, unknown> = {}
      return {
        // Mirrors the real query: .select('*').eq('verified', true).eq('network', ...).limit(100)
        select: () => {
          const query = {
            eq: (column: string, value: unknown) => {
              filters[column] = value
              return query
            },
            limit: () => {
              const data = error
                ? null
                : rows
                  ? rows.filter((r) =>
                      Object.entries(filters).every(
                        ([column, value]) => (r as Record<string, unknown>)[column] === value,
                      ),
                    )
                  : rows
              return Promise.resolve({ data, error })
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
  ) {
    super({
      ...(supabase ? { supabase: supabase as any } : {}),
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
