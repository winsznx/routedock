import * as http from 'node:http'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import { fetchManifest } from '../ModeRouter.js'
import { RouteDockClientVersionError, RouteDockManifestError } from '../../errors.js'
import { signManifest } from '../../manifest/sign.js'
import type { RouteDockManifest } from '../../types.js'

const signingKey = Keypair.random()

function createManifest(overrides: Partial<RouteDockManifest> = {}): RouteDockManifest {
  return {
    routedock: '1.0',
    name: 'Manifest Version Test Provider',
    description: 'Manifest used to verify schema major version gating',
    modes: ['x402', 'mpp-charge'],
    network: 'testnet',
    asset: 'USDC',
    asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
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

async function withManifest<T>(
  manifest: RouteDockManifest,
  run: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = await startManifestServer(signed(manifest))
  try {
    return await run(server.baseUrl)
  } finally {
    await server.close()
  }
}

function assertClientVersionRejection(version: string, baseUrl: string) {
  return (error: unknown) => {
    assert.ok(error instanceof RouteDockClientVersionError, `expected typed error for ${version}`)
    assert.equal(error.code, 'CLIENT_VERSION_TOO_OLD')
    assert.equal(error.retryable, false)
    assert.ok(error.message.includes(version), `message must name ${version}: ${error.message}`)
    assert.ok(
      error.message.includes(baseUrl),
      `message must name the provider URL: ${error.message}`,
    )
    return true
  }
}

describe('fetchManifest — manifest schema major version gate', () => {
  it('rejects a signed, schema-valid 2.0 manifest', async () => {
    await withManifest(createManifest({ routedock: '2.0' }), async (baseUrl) => {
      await assert.rejects(() => fetchManifest(baseUrl), assertClientVersionRejection('2.0', baseUrl))
    })
  })

  it('rejects a signed, schema-valid 9.0 manifest', async () => {
    await withManifest(createManifest({ routedock: '9.0' }), async (baseUrl) => {
      await assert.rejects(() => fetchManifest(baseUrl), assertClientVersionRejection('9.0', baseUrl))
    })
  })

  it('accepts 1.0 on the fresh path and on a cache hit', async () => {
    await withManifest(createManifest({ routedock: '1.0' }), async (baseUrl) => {
      const first = await fetchManifest(baseUrl)
      assert.equal(first.routedock, '1.0')
      const cached = await fetchManifest(baseUrl)
      assert.equal(cached.routedock, '1.0')
    })
  })

  it('accepts an additive 1.3 minor on the fresh path and on a cache hit', async () => {
    await withManifest(createManifest({ routedock: '1.3' }), async (baseUrl) => {
      const first = await fetchManifest(baseUrl)
      assert.equal(first.routedock, '1.3')
      const cached = await fetchManifest(baseUrl)
      assert.equal(cached.routedock, '1.3')
    })
  })

  it('does not cache a rejected manifest, so the next fetch rejects again', async () => {
    await withManifest(createManifest({ routedock: '2.0' }), async (baseUrl) => {
      await assert.rejects(() => fetchManifest(baseUrl), assertClientVersionRejection('2.0', baseUrl))
      await assert.rejects(() => fetchManifest(baseUrl), assertClientVersionRejection('2.0', baseUrl))
    })
  })

  it('still reports a malformed manifest as a schema error rather than a version error', async () => {
    const server = await startManifestServer({ routedock: '2.0', name: 'bad' })
    try {
      await assert.rejects(
        () => fetchManifest(server.baseUrl),
        (error: unknown) => {
          assert.ok(error instanceof RouteDockManifestError)
          assert.ok(!(error instanceof RouteDockClientVersionError))
          assert.ok(error.message.includes('Invalid manifest'))
          return true
        },
      )
    } finally {
      await server.close()
    }
  })
})
