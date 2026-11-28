/**
 * Registry-backed list_providers and payee-bound pay_for_data / open_session
 * (issue #762).
 */
import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { createServer, type Server } from 'node:http'
import { Keypair } from '@stellar/stellar-sdk'
import {
  ProviderRegistry,
  RouteDockSignatureError,
  signManifest,
  type ProviderRecord,
  type RouteDockManifest,
} from '@routedock/routedock'
import {
  handleListProviders,
  handleOpenSession,
  handlePayForData,
  type HandlerDeps,
  type RegistryDep,
} from '../handlers.js'
import { parseEnv } from '../env.js'

const registeredPayee = Keypair.random()
const attacker = Keypair.random()

function manifestFor(payee: Keypair): RouteDockManifest {
  return {
    routedock: '1.0',
    name: 'Listed Provider',
    description: 'registry test provider',
    modes: ['x402'],
    network: 'testnet',
    asset: 'USDC',
    asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    payee: payee.publicKey(),
    pricing: { x402: { amount: '0.001', per: 'request' } },
    endpoints: { price: { method: 'GET', path: '/price' } },
    tags: ['price'],
  }
}

function record(baseUrl: string, overrides: Partial<ProviderRecord> = {}): ProviderRecord {
  return {
    name: 'Listed Provider',
    description: 'desc',
    base_url: baseUrl,
    modes: ['x402'],
    tags: ['price'],
    network: 'testnet',
    payee: registeredPayee.publicKey(),
    source: 'supabase',
    verified: true,
    ...overrides,
  }
}

/** A real ProviderRegistry whose listing is fixed, so fetchProviderManifest is the real payee-bound fetch. */
class FixedRegistry extends ProviderRegistry {
  constructor(private readonly records: ProviderRecord[]) {
    super({ onChain: { horizonUrl: 'https://horizon-testnet.stellar.org', knownAccounts: [] } })
  }
  override async listProviders(): Promise<ProviderRecord[]> {
    return this.records
  }
}

/** Counts every call so a test can prove nothing was estimated, paid or opened. */
function spyClient() {
  const calls = { estimateCost: 0, pay: 0, openSession: 0 }
  const seen: { estimateCost?: unknown; pay?: unknown; openSession?: unknown } = {}
  const client = {
    estimateCost: async (_url: string, options?: unknown) => {
      seen.estimateCost = options
      calls.estimateCost++
      return { amount: '0.001', asset: 'USDC', mode: 'x402' }
    },
    pay: async (_url: string, options?: unknown) => {
      seen.pay = options
      calls.pay++
      return { mode: 'x402', amount: '0.001', txHash: 'TX', timestamp: 1, data: {} }
    },
    openSession: async (_url: string, options?: unknown) => {
      seen.openSession = options
      calls.openSession++
      return { channelId: 'C1', openTxHash: 'TX' }
    },
  } as unknown as HandlerDeps['client']
  return { client, calls, seen }
}

function depsFor(registry: RegistryDep | null, client: HandlerDeps['client']): HandlerDeps {
  return {
    client,
    openSessions: new Map(),
    supabase: null,
    registry,
    stellarSecret: Keypair.random().secret(),
    stellarNetwork: 'testnet',
  }
}

function startServer(signer: Keypair): Promise<{ server: Server; baseUrl: string }> {
  const signed = signManifest(manifestFor(signer), signer.secret())
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(signed))
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      assert.ok(addr && typeof addr === 'object')
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` })
    }),
  )
}

const close = (server: Server) =>
  new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())))

/** Serves the registered payee's manifest first, then a different key's, with no-store caching. */
function startSwappingServer(first: Keypair, later: Keypair): Promise<{ server: Server; baseUrl: string }> {
  const firstDoc = signManifest(manifestFor(first), first.secret())
  const laterDoc = signManifest(manifestFor(later), later.secret())
  let served = 0
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(served++ === 0 ? firstDoc : laterDoc))
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      assert.ok(addr && typeof addr === 'object')
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` })
    }),
  )
}

describe('pay_for_data / open_session bind the registered payee (#762)', () => {
  let honest: { server: Server; baseUrl: string }

  before(async () => {
    honest = await startServer(registeredPayee)
  })
  after(async () => {
    await close(honest.server)
  })

  it('passes the registered payee to estimateCost and pay as a per-call expectedPayee', async () => {
    const { client, calls, seen } = spyClient()
    const deps = depsFor(new FixedRegistry([record(honest.baseUrl)]), client)

    const result = await handlePayForData({ url: `${honest.baseUrl}/price`, max_amount: '0.01' }, deps)
    assert.equal(result.isError, undefined)
    assert.deepEqual(calls, { estimateCost: 1, pay: 1, openSession: 0 })
    const expected = { expectedPayee: registeredPayee.publicKey() }
    assert.deepEqual(seen.estimateCost, expected)
    assert.deepEqual(seen.pay, expected)
  })

  it('open_session binds the registered payee on openSession', async () => {
    const { client, seen } = spyClient()
    const deps = depsFor(new FixedRegistry([record(honest.baseUrl)]), client)

    await handleOpenSession({ url: `${honest.baseUrl}/stream` }, deps, 'SCOMMITMENT')
    assert.deepEqual(seen.openSession, { expectedPayee: registeredPayee.publicKey() })
  })

  it('does not bind unlisted URLs or unverified (self-asserted) payees', async () => {
    const unlisted = spyClient()
    await handlePayForData(
      { url: `${honest.baseUrl}/price`, max_amount: '0.01' },
      depsFor(new FixedRegistry([record('https://other.example.com')]), unlisted.client),
    )
    assert.equal(unlisted.seen.pay, undefined)

    const unverified = spyClient()
    await handlePayForData(
      { url: `${honest.baseUrl}/price`, max_amount: '0.01' },
      depsFor(new FixedRegistry([record(honest.baseUrl, { verified: false })]), unverified.client),
    )
    assert.equal(unverified.seen.pay, undefined)
  })

  it('matches the listed origin regardless of case and path', async () => {
    const { client, seen } = spyClient()
    const upper = honest.baseUrl.replace('http://127', 'HTTP://127')
    const deps = depsFor(new FixedRegistry([record(`${upper}/`)]), client)

    await handlePayForData({ url: `${honest.baseUrl}/price?x=1`, max_amount: '0.01' }, deps)
    assert.deepEqual(seen.pay, { expectedPayee: registeredPayee.publicKey() })
  })

  it('reuses one registry lookup across payments', async () => {
    const { client } = spyClient()
    let lookups = 0
    class Counting extends FixedRegistry {
      override async listProviders(): Promise<ProviderRecord[]> {
        lookups++
        return super.listProviders()
      }
    }
    const deps = depsFor(new Counting([record(honest.baseUrl)]), client)
    await handlePayForData({ url: `${honest.baseUrl}/price`, max_amount: '0.01' }, deps)
    await handlePayForData({ url: `${honest.baseUrl}/price`, max_amount: '0.01' }, deps)
    assert.equal(lookups, 1)
  })

  it('a real client rejects a provider that swaps manifests between requests (no-store)', async () => {
    // First request: the registered payee's manifest. Every later request: a
    // manifest self-signed by another key. Binding only the first fetch would
    // let the payment through; the payment itself must carry the payee.
    const swapping = await startSwappingServer(registeredPayee, attacker)
    try {
      const { RouteDockClient, InMemorySpendStore } = await import('@routedock/routedock')
      const client = new RouteDockClient({
        wallet: Keypair.random(),
        network: 'testnet',
        spendCap: { daily: '1.00', asset: 'USDC' },
        spendStore: new InMemorySpendStore({ warn: false }),
      })
      const deps = depsFor(new FixedRegistry([record(swapping.baseUrl)]), client)

      await assert.rejects(
        handlePayForData({ url: `${swapping.baseUrl}/price`, max_amount: '0.01' }, deps),
        (err: unknown) =>
          err instanceof RouteDockSignatureError && err.message.includes('does not match expected payee'),
      )
    } finally {
      await close(swapping.server)
    }
  })
})

describe('list_providers backed by the registry (#762)', () => {
  const rows: ProviderRecord[] = [
    record('https://listed.example.com', { assets: ['USDC'] }),
    record('https://onchain.example.com', {
      name: 'On-chain provider (GABC...)',
      source: 'onchain',
      tags: ['dex'],
      payee: 'GONCHAINPAYEE',
      modes: [],
    }),
  ]
  const stub = (list: ProviderRecord[]): RegistryDep => ({
    listProviders: async (options) => {
      const tags = options?.tags ?? []
      return list.filter(
        (r) =>
          (options?.includeUnverified === true || r.verified) &&
          (tags.length === 0 || r.tags.some((t) => tags.includes(t))),
      )
    },
  })

  it('works without Supabase and includes the payee on every row', async () => {
    const { client } = spyClient()
    const result = await handleListProviders({}, depsFor(stub(rows), client))
    assert.equal(result.isError, undefined)
    const body = JSON.parse(result.content[0]!.text)
    assert.equal(body.count, 2)
    assert.deepEqual(
      body.providers.map((p: { payee: string; source: string }) => [p.payee, p.source]),
      [
        [registeredPayee.publicKey(), 'supabase'],
        ['GONCHAINPAYEE', 'onchain'],
      ],
    )
    assert.equal(body.providers[0].asset, 'USDC')
    assert.equal(body.providers[1].asset, null)
  })

  it('filters by tag and applies the limit', async () => {
    const { client } = spyClient()
    const deps = depsFor(stub(rows), client)
    const tagged = JSON.parse((await handleListProviders({ tags: 'dex' }, deps)).content[0]!.text)
    assert.deepEqual(tagged.providers.map((p: { source: string }) => p.source), ['onchain'])

    const limited = JSON.parse((await handleListProviders({ limit: 1 }, deps)).content[0]!.text)
    assert.equal(limited.count, 1)
    assert.equal(limited.truncated, true)
  })

  it('keeps unverified providers in the listing, flagged verified:false', async () => {
    const { client } = spyClient()
    const mixed = [...rows, record('https://selfreg.example.com', { verified: false, name: 'Self registered' })]
    const body = JSON.parse((await handleListProviders({}, depsFor(stub(mixed), client))).content[0]!.text)
    assert.equal(body.count, 3)
    const self = body.providers.find((p: { name: string }) => p.name === 'Self registered')
    assert.equal(self.verified, false)
  })

  it('asks the registry to filter tags (before its row limit)', async () => {
    const { client } = spyClient()
    let received: unknown
    const deps = depsFor(
      {
        listProviders: async (options) => {
          received = options
          return []
        },
      },
      client,
    )
    await handleListProviders({ tags: 'dex, price' }, deps)
    assert.deepEqual(received, { includeUnverified: true, tags: ['dex', 'price'] })
  })

  it('without a registry or Supabase explains how to configure one', async () => {
    const { client } = spyClient()
    const result = await handleListProviders({}, depsFor(null, client))
    assert.equal(result.isError, true)
    assert.match(result.content[0]!.text, /ROUTEDOCK_REGISTRY_ACCOUNTS/)
  })

  it('includes the payee on the Supabase-only path too', async () => {
    const { client } = spyClient()
    const builder: unknown = Object.assign(
      Promise.resolve({
        data: [{ name: 'A', description: 'd', network: 'testnet', base_url: 'https://a.io', modes: [], tags: [], payee: 'GPAYEE', verified: true }],
        error: null,
      }),
      {
        eq: () => builder,
        overlaps: () => builder,
        order: () => builder,
        limit: () => builder,
      },
    )
    const deps = depsFor(null, client)
    deps.supabase = { from: () => ({ select: () => builder as never }) }
    const body = JSON.parse((await handleListProviders({}, deps)).content[0]!.text)
    assert.equal(body.providers[0].payee, 'GPAYEE')
  })
})

describe('ROUTEDOCK_REGISTRY_ACCOUNTS (#762)', () => {
  const base = { STELLAR_SECRET: Keypair.random().secret(), ROUTEDOCK_DAILY_CAP: '1' }

  it('parses a comma-separated list of public keys', () => {
    const a = Keypair.random().publicKey()
    const b = Keypair.random().publicKey()
    const config = parseEnv({ ...base, ROUTEDOCK_REGISTRY_ACCOUNTS: ` ${a}, ${b} ,` }, { warn: () => {} })
    assert.deepEqual(config.registryAccounts, [a, b])
  })

  it('defaults to no accounts and rejects an invalid one', () => {
    assert.deepEqual(parseEnv(base, { warn: () => {} }).registryAccounts, [])
    assert.throws(
      () => parseEnv({ ...base, ROUTEDOCK_REGISTRY_ACCOUNTS: 'not-a-key' }, { warn: () => {} }),
      /Invalid ROUTEDOCK_REGISTRY_ACCOUNTS entry "not-a-key"/,
    )
  })
})
