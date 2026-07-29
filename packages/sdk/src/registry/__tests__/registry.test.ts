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
  // @ts-expect-error — override private field for testing
  constructor(mockHorizon: ReturnType<typeof makeHorizonMock>, knownAccounts: string[]) {
    super({ horizonUrl: 'https://horizon-testnet.stellar.org', knownAccounts })
    // @ts-expect-error — override private field for testing
    this.horizon = mockHorizon
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
    assert.equal(providers[0].endpoint, url)
    assert.equal(providers[0].account, 'ACCT1')
  })

  it('returns a plain URL as-is without decoding', async () => {
    const url = 'https://plain-url.example.com'
    const registry = new TestOnChainRegistry(
      makeHorizonMock({ ACCT2: { routedock_endpoint: url } }),
      ['ACCT2'],
    )
    const providers = await registry.listProviders()
    assert.equal(providers.length, 1)
    assert.equal(providers[0].endpoint, url)
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
    assert.deepEqual(providers[0].tags, ['ai', 'stellar', 'dex'])
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
    assert.deepEqual(providers[0].tags, ['ai', 'stellar', 'dex'])
  })

  it('returns empty tags when no routedock_tags entry', async () => {
    const registry = new TestOnChainRegistry(
      makeHorizonMock({
        ACCT8: { routedock_endpoint: 'https://provider.example.com' },
      }),
      ['ACCT8'],
    )
    const providers = await registry.listProviders()
    assert.deepEqual(providers[0].tags, [])
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
    from: () => ({
      select: () => ({
        limit: () => Promise.resolve({ data: rows, error }),
      }),
    }),
  } as unknown as ConstructorParameters<typeof ProviderRegistry>[0]['supabase']
}

class TestProviderRegistry extends ProviderRegistry {
  constructor(
    supabase: ReturnType<typeof makeSupabaseMock> | undefined,
    mockHorizon: ReturnType<typeof makeHorizonMock>,
  ) {
    super({
      supabase,
      onChain: { horizonUrl: 'https://horizon-testnet.stellar.org', knownAccounts: ['ACCT9'] },
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
    assert.equal(providers[0].name, 'Provider A')
    assert.equal(providers[0].source, 'supabase')
  })
})

describe('ProviderRegistry.listProviders — on-chain fallback', () => {
  it('falls back to on-chain when Supabase returns empty', async () => {
    const registry = new TestProviderRegistry(makeSupabaseMock([]), oneOnChain)
    const providers = await registry.listProviders()
    assert.equal(providers.length, 1)
    assert.equal(providers[0].source, 'onchain')
  })

  it('falls back to on-chain when Supabase returns an error', async () => {
    const registry = new TestProviderRegistry(
      makeSupabaseMock(null, { message: 'Connection refused' }),
      oneOnChain,
    )
    const providers = await registry.listProviders()
    assert.equal(providers.length, 1)
    assert.equal(providers[0].source, 'onchain')
  })

  it('goes straight to on-chain when no Supabase configured', async () => {
    const registry = new TestProviderRegistry(undefined, oneOnChain)
    const providers = await registry.listProviders()
    assert.equal(providers.length, 1)
    assert.equal(providers[0].source, 'onchain')
  })
})
