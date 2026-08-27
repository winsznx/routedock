import * as http from 'node:http'
import assert from 'node:assert/strict'
import { Keypair } from '@stellar/stellar-sdk'
import { fetchManifest, selectMode } from '../ModeRouter.js'
import {
  RouteDockManifestError,
  RouteDockManifestSunsetError,
} from '../../errors.js'
import { signManifest } from '../../manifest/sign.js'
import type { RouteDockManifest } from '../../types.js'

const signingKey = Keypair.random()

function createManifest(overrides: Partial<RouteDockManifest> = {}): RouteDockManifest {
  return {
    routedock: '1.0',
    name: 'Deprecation Test Provider',
    description: 'Manifest used to verify deprecation and sunset enforcement',
    modes: ['x402', 'mpp-charge'],
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
      'mpp-charge': {
        amount: '0.01',
        per: 'request',
      },
    },
    endpoints: {
      price: {
        method: 'GET',
        path: '/price',
      },
    },
    tags: ['test'],
    ...overrides,
  }
}

function signed(manifest: RouteDockManifest): RouteDockManifest & { signature: string } {
  return signManifest(manifest, signingKey.secret())
}

function startManifestServer(
  body: unknown,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as { port: number }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      })
    })
  })
}

// Active x402 must beat the normally preferred but deprecated mpp-charge.
{
  const logs: string[] = []
  const manifest = createManifest({ deprecated_modes: ['mpp-charge'] })
  assert.equal(selectMode(manifest, { logger: (message) => logs.push(message) }), 'x402')
  assert.equal(logs.some((message) => message.includes('WARNING')), false)
}

// Cost optimization must ignore a cheaper deprecated mode while an active mode exists.
{
  const manifest = createManifest({ deprecated_modes: ['mpp-charge'] })
  assert.equal(selectMode(manifest, { optimize: 'cost' }), 'x402')
}

// Sustained + websocket transport must prefer mpp-session-ws when advertised.
{
  const manifest = createManifest({
    modes: ['mpp-session', 'mpp-session-ws'],
    pricing: {
      'mpp-session': {
        rate: '0.001',
        per: 'voucher',
        channel_factory: 'CTESTCHANNELFACTORY',
        min_deposit: '0.10',
        refund_waiting_period_ledgers: 17280,
      },
      'mpp-session-ws': {
        rate: '0.001',
        per: 'voucher',
        channel_factory: 'CTESTCHANNELFACTORY',
        min_deposit: '0.10',
        refund_waiting_period_ledgers: 17280,
      },
    },
  })
  assert.equal(selectMode(manifest, { sustained: true, transport: 'websocket' }), 'mpp-session-ws')
  assert.equal(selectMode(manifest, { sustained: true }), 'mpp-session')
}

// Sustained + websocket falls back to SSE mpp-session when WS is not advertised.
{
  const manifest = createManifest({
    modes: ['mpp-session'],
    pricing: {
      'mpp-session': {
        rate: '0.001',
        per: 'voucher',
        channel_factory: 'CTESTCHANNELFACTORY',
        min_deposit: '0.10',
        refund_waiting_period_ledgers: 17280,
      },
    },
  })
  assert.equal(selectMode(manifest, { sustained: true, transport: 'websocket' }), 'mpp-session')
}

// Sustained without an explicit transport still uses mpp-session-ws as a
// fallback when that is the only session variant advertised.
{
  const manifest = createManifest({
    modes: ['mpp-session-ws'],
    pricing: {
      'mpp-session-ws': {
        rate: '0.001',
        per: 'voucher',
        channel_factory: 'CTESTCHANNELFACTORY',
        min_deposit: '0.10',
        refund_waiting_period_ledgers: 17280,
      },
    },
  })
  assert.equal(selectMode(manifest, { sustained: true }), 'mpp-session-ws')
}

// Forcing mpp-session-ws is authoritative when supported, and rejected otherwise.
{
  const supported = createManifest({
    modes: ['mpp-session-ws'],
    pricing: {
      'mpp-session-ws': {
        rate: '0.001',
        per: 'voucher',
        channel_factory: 'CTESTCHANNELFACTORY',
        min_deposit: '0.10',
        refund_waiting_period_ledgers: 17280,
      },
    },
  })
  assert.equal(selectMode(supported, { forceMode: 'mpp-session-ws' }), 'mpp-session-ws')

  const unsupported = createManifest()
  assert.throws(
    () => selectMode(unsupported, { forceMode: 'mpp-session-ws' }),
    /does not support forced mode/,
  )
}

// Sustained routing must not prefer a deprecated session mode over a live mode.
{
  const manifest = createManifest({
    modes: ['x402', 'mpp-session'],
    deprecated_modes: ['mpp-session'],
    pricing: {
      x402: {
        amount: '1.00',
        per: 'request',
        facilitator: 'https://facilitator.example',
      },
      'mpp-session': {
        rate: '0.001',
        per: 'voucher',
        channel_factory: 'CTESTCHANNELFACTORY',
        min_deposit: '0.10',
        refund_waiting_period_ledgers: 17280,
      },
    },
  })
  assert.equal(selectMode(manifest, { sustained: true }), 'x402')
}

// If only deprecated choices remain, preserve compatibility and warn.
{
  const logs: string[] = []
  const manifest = createManifest({ deprecated_modes: ['x402', 'mpp-charge'] })
  assert.equal(selectMode(manifest, { logger: (message) => logs.push(message) }), 'mpp-charge')
  assert.ok(logs.some((message) => message.includes('WARNING') && message.includes('deprecated')))
}

// Explicit force remains authoritative but must warn when forcing a deprecated mode.
{
  const logs: string[] = []
  const manifest = createManifest({ deprecated_modes: ['mpp-charge'] })
  assert.equal(
    selectMode(manifest, {
      forceMode: 'mpp-charge',
      logger: (message) => logs.push(message),
    }),
    'mpp-charge',
  )
  assert.ok(logs.some((message) => message.includes('WARNING') && message.includes('forced')))
}

// A freshly fetched manifest that has already sunset must be rejected with a typed error.
{
  const manifest = signed(
    createManifest({ sunset_at: new Date(Date.now() - 1_000).toISOString() }),
  )
  const server = await startManifestServer(manifest)
  try {
    await assert.rejects(
      () => fetchManifest(server.baseUrl),
      (error: unknown) => {
        assert.ok(error instanceof RouteDockManifestSunsetError)
        assert.equal(error.code, 'MANIFEST_SUNSET')
        assert.equal(error.retryable, false)
        return true
      },
    )
  } finally {
    await server.close()
  }
}

// Endpoint metadata must survive validation, and a cached manifest must expire at sunset.
{
  const realDateNow = Date.now
  let now = 1_800_000_000_000
  Date.now = () => now

  const endpointSunset = new Date(now + 60_000).toISOString()
  const manifestSunset = new Date(now + 1_000).toISOString()
  const manifest = signed(
    createManifest({
      sunset_at: manifestSunset,
      endpoints: {
        price: {
          method: 'GET',
          path: '/price',
          deprecated: true,
          sunset_at: endpointSunset,
        },
      },
    }),
  )
  const server = await startManifestServer(manifest)

  try {
    const first = await fetchManifest(server.baseUrl)
    assert.equal(first.endpoints.price?.deprecated, true)
    assert.equal(first.endpoints.price?.sunset_at, endpointSunset)

    now += 2_000
    await assert.rejects(
      () => fetchManifest(server.baseUrl),
      (error: unknown) => error instanceof RouteDockManifestSunsetError,
    )
  } finally {
    Date.now = realDateNow
    await server.close()
  }
}

// Invalid per-endpoint sunset timestamps must fail strict schema validation.
{
  const invalid = createManifest({
    endpoints: {
      price: {
        method: 'GET',
        path: '/price',
        sunset_at: 'not-a-date',
      },
    },
  })
  const server = await startManifestServer(signed(invalid))
  try {
    await assert.rejects(
      () => fetchManifest(server.baseUrl),
      (error: unknown) => {
        assert.ok(error instanceof RouteDockManifestError)
        assert.ok(!(error instanceof RouteDockManifestSunsetError))
        assert.ok(error.message.includes('Invalid manifest'))
        return true
      },
    )
  } finally {
    await server.close()
  }
}

console.log('All mode deprecation and manifest sunset tests passed.')
