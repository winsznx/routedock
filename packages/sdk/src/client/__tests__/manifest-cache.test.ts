/**
 * Tests for manifest cache invalidation (#29).
 *
 * The manifest cache must honor per-entry freshness from the provider's
 * response headers (`Cache-Control: max-age` / `Expires`) instead of a fixed
 * 60s TTL, and `RouteDockClient.invalidateManifest(url)` must evict a cached
 * entry before expiry so a provider's manifest change takes effect
 * immediately.
 *
 * Mirrors mode-deprecation.test.ts: a real local HTTP server serves a signed
 * manifest with configurable response headers, and Date.now is mocked to
 * advance time past TTL windows without sleeping.
 *
 * Run with: pnpm --filter @routedock/routedock test
 */

import * as http from 'node:http'
import assert from 'node:assert/strict'
import { Keypair } from '@stellar/stellar-sdk'
import { fetchManifest, invalidateManifest } from '../ModeRouter.js'
import { RouteDockClient } from '../RouteDockClient.js'
import { signManifest } from '../../manifest/sign.js'
import type { RouteDockManifest } from '../../types.js'

const signingKey = Keypair.random()

function createManifest(): RouteDockManifest {
  return {
    routedock: '1.0',
    name: 'Cache Test Provider',
    description: 'Manifest used to verify cache invalidation behavior',
    modes: ['x402'],
    network: 'testnet',
    asset: 'USDC',
    asset_contract: 'CTESTASSETCONTRACT',
    payee: signingKey.publicKey(),
    pricing: {
      x402: {
        amount: '1.00',
        per: 'request',
        facilitator: 'https://facilitator.example',
      },
    },
    endpoints: {
      price: {
        method: 'GET',
        path: '/price',
      },
    },
    tags: ['test'],
  }
}

const signedManifest = signManifest(createManifest(), signingKey.secret())

/**
 * Start a manifest server that counts hits. Each request increments `hits`
 * and serves the signed manifest with the given extra response headers.
 */
function startManifestServer(
  headers: Record<string, string>,
): Promise<{ baseUrl: string; hits: { count: number }; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const hits = { count: 0 }
    const server = http.createServer((_req, res) => {
      hits.count += 1
      res.writeHead(200, {
        'Content-Type': 'application/json',
        ...headers,
      })
      res.end(JSON.stringify(signedManifest))
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        hits,
        close: () => new Promise<void>((done) => server.close(() => done())),
      })
    })
  })
}

// ── Cache-Control: max-age is honored for per-entry TTL ─────────────────────

{
  const realDateNow = Date.now
  const now = 1_800_000_000_000
  const server = await startManifestServer({ 'Cache-Control': 'max-age=120' })
  try {
    Date.now = () => now
    const first = await fetchManifest(server.baseUrl)
    assert.equal(server.hits.count, 1, 'first fetch must hit the server')

    // Advance past the old fixed 60s default but inside the provider's 120s
    // max-age: the entry must still be served from cache, proving the header
    // (not the default) now governs freshness.
    Date.now = () => now + 90_000
    const cached = await fetchManifest(server.baseUrl)
    assert.equal(cached, first, 'entry must stay cached past the old 60s default while max-age is live')
    assert.equal(server.hits.count, 1, 'no server hit while the header-declared TTL is live')

    // Advance past the provider-declared TTL → must refetch.
    Date.now = () => now + 121_000
    const refetched = await fetchManifest(server.baseUrl)
    assert.notEqual(refetched, first, 'expired max-age entry must be refetched')
    assert.equal(server.hits.count, 2, 'expired entry must hit the server again')
  } finally {
    Date.now = realDateNow
    await server.close()
  }
}

// ── Cache-Control: max-age=0 disables caching for that response ─────────────

{
  const server = await startManifestServer({ 'Cache-Control': 'max-age=0' })
  try {
    await fetchManifest(server.baseUrl)
    await fetchManifest(server.baseUrl)
    assert.equal(server.hits.count, 2, 'max-age=0 must never serve from cache')
  } finally {
    await server.close()
  }
}

// ── Cache-Control: no-store disables caching (RFC 9111) ──────────────────────

{
  const server = await startManifestServer({ 'Cache-Control': 'no-store' })
  try {
    await fetchManifest(server.baseUrl)
    await fetchManifest(server.baseUrl)
    assert.equal(server.hits.count, 2, 'no-store must never serve from cache')
  } finally {
    await server.close()
  }
}

// ── Cache-Control: no-cache disables caching (no revalidation path exists) ──

{
  const server = await startManifestServer({ 'Cache-Control': 'no-cache' })
  try {
    await fetchManifest(server.baseUrl)
    await fetchManifest(server.baseUrl)
    assert.equal(server.hits.count, 2, 'no-cache must never serve from cache')
  } finally {
    await server.close()
  }
}

// ── no-store wins over a max-age on the same header ──────────────────────────

{
  const server = await startManifestServer({ 'Cache-Control': 'no-store, max-age=300' })
  try {
    await fetchManifest(server.baseUrl)
    await fetchManifest(server.baseUrl)
    assert.equal(server.hits.count, 2, 'no-store must take precedence over max-age')
  } finally {
    await server.close()
  }
}

// ── no-store/no-cache directive matching is case-insensitive ────────────────

{
  const server = await startManifestServer({ 'Cache-Control': 'No-Store' })
  try {
    await fetchManifest(server.baseUrl)
    await fetchManifest(server.baseUrl)
    assert.equal(server.hits.count, 2, 'directive matching must be case-insensitive')
  } finally {
    await server.close()
  }
}

// ── Expires header is honored for per-entry TTL ──────────────────────────────

{
  const realDateNow = Date.now
  const now = 1_800_000_000_000
  const server = await startManifestServer({
    Expires: new Date(now + 60_000).toUTCString(),
  })
  try {
    Date.now = () => now
    const first = await fetchManifest(server.baseUrl)
    assert.equal(server.hits.count, 1)

    // Within the Expires window → cached.
    const cached = await fetchManifest(server.baseUrl)
    assert.equal(cached, first, 'second fetch within Expires must return cached manifest')
    assert.equal(server.hits.count, 1)

    // Past Expires → refetch.
    Date.now = () => now + 61_000
    const refetched = await fetchManifest(server.baseUrl)
    assert.notEqual(refetched, first, 'expired Expires entry must be refetched')
    assert.equal(server.hits.count, 2)
  } finally {
    Date.now = realDateNow
    await server.close()
  }
}

// ── Cache-Control: max-age wins over Expires (RFC 9111 precedence) ──────────

{
  const realDateNow = Date.now
  const now = 1_800_000_000_000
  const server = await startManifestServer({
    'Cache-Control': 'max-age=3600',
    Expires: new Date(now - 1_000).toUTCString(), // already expired
  })
  try {
    Date.now = () => now
    const first = await fetchManifest(server.baseUrl)

    // max-age says fresh for an hour — Expires being in the past must be ignored.
    const cached = await fetchManifest(server.baseUrl)
    assert.equal(cached, first, 'max-age must take precedence over an expired Expires header')
    assert.equal(server.hits.count, 1)
  } finally {
    Date.now = realDateNow
    await server.close()
  }
}

// ── Unparseable headers fall back to the default TTL ─────────────────────────

{
  const server = await startManifestServer({
    'Cache-Control': 'max-age=banana',
    Expires: 'not-a-date',
  })
  try {
    const first = await fetchManifest(server.baseUrl)
    const cached = await fetchManifest(server.baseUrl)
    assert.equal(cached, first, 'invalid freshness headers must fall back to the default TTL')
    assert.equal(server.hits.count, 1)
  } finally {
    await server.close()
  }
}

// ── invalidateManifest() evicts a fresh cached entry ─────────────────────────

{
  const server = await startManifestServer({ 'Cache-Control': 'max-age=3600' })
  try {
    const first = await fetchManifest(server.baseUrl)
    const cached = await fetchManifest(server.baseUrl)
    assert.equal(cached, first, 'entry must be cached before invalidation')
    assert.equal(server.hits.count, 1)

    invalidateManifest(server.baseUrl)

    // Next fetch must go back to the server even though max-age is still live.
    const refetched = await fetchManifest(server.baseUrl)
    assert.notEqual(refetched, first, 'invalidateManifest must force a refetch')
    assert.equal(server.hits.count, 2)
  } finally {
    await server.close()
  }
}

// ── RouteDockClient.invalidateManifest() evicts by URL ──────────────────────

{
  const server = await startManifestServer({ 'Cache-Control': 'max-age=3600' })
  try {
    const client = new RouteDockClient({
      wallet: Keypair.random().secret(),
      network: 'testnet',
    })

    const first = await fetchManifest(server.baseUrl)
    const cached = await fetchManifest(server.baseUrl)
    assert.equal(cached, first, 'entry must be cached before client-side invalidation')
    assert.equal(server.hits.count, 1)

    // URL with path/trailing slash — the client normalizes to the origin,
    // matching the key fetchManifest caches under.
    client.invalidateManifest(server.baseUrl + '/some/path/')

    const refetched = await fetchManifest(server.baseUrl)
    assert.notEqual(refetched, first, 'client.invalidateManifest must force a refetch')
    assert.equal(server.hits.count, 2)
  } finally {
    await server.close()
  }
}

// ── Evicting an absent entry is a no-op ─────────────────────────────────────

{
  invalidateManifest('http://127.0.0.1:1/never-fetched')
  console.log('✓ Evicting a never-fetched URL is a no-op (no throw)')
}

console.log('All manifest cache invalidation tests passed.')
