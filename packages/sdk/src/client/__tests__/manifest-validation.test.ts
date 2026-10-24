/**
 * Manifests are untrusted input. These tests pin that every malformed manifest
 * is refused with a typed RouteDockError at fetch/preflight time, instead of a
 * raw TypeError/Error/RangeError later inside pay() or estimateCost() (#327).
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, it } from 'node:test'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { Keypair } from '@stellar/stellar-sdk'
import schema from '../../schemas/routedock.schema.json' with { type: 'json' }
import { RouteDockClient } from '../RouteDockClient.js'
import { assertManifestValid, fetchManifest } from '../ModeRouter.js'
import {
  RouteDockError,
  RouteDockManifestError,
  RouteDockSignatureError,
} from '../../errors.js'
import { signManifest, verifyManifestSignature } from '../../manifest/sign.js'
import type { RouteDockManifest } from '../../types.js'

const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const CHANNEL_FACTORY = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'
const PAYEE = Keypair.random()
const OTHER_PAYEE = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
const PLACEHOLDER_PAYEE = 'G...'

function manifest(overrides: Record<string, unknown> = {}): RouteDockManifest {
  return {
    routedock: '1.0',
    name: 'Validation Test Provider',
    description: 'Provider used by manifest-validation tests',
    modes: ['x402', 'mpp-charge', 'mpp-session', 'mpp-session-ws'],
    network: 'testnet',
    asset: 'USDC',
    asset_contract: ASSET_CONTRACT,
    payee: PAYEE.publicKey(),
    pricing: {
      x402: { amount: '0.001', per: 'request', facilitator: 'https://channels.openzeppelin.com/x402/testnet' },
      'mpp-charge': { amount: '0.0008', per: 'request' },
      'mpp-session': {
        rate: '0.0001',
        per: 'voucher',
        channel_factory: CHANNEL_FACTORY,
        min_deposit: '0.10',
        refund_waiting_period_ledgers: 17280,
      },
      'mpp-session-ws': {
        rate: '0.0002',
        per: 'voucher',
        channel_factory: CHANNEL_FACTORY,
        min_deposit: '0.10',
        refund_waiting_period_ledgers: 17280,
      },
    },
    endpoints: { price: { method: 'GET', path: '/price' } },
    tags: ['test'],
    ...overrides,
  } as unknown as RouteDockManifest
}

/** Same shape as apps/provider-a/src/manifest.ts. */
function providerAShaped(): RouteDockManifest {
  return manifest({
    name: 'Stellar DEX Price Feed',
    modes: ['x402', 'mpp-charge'],
    pricing: {
      x402: { amount: '0.001', per: 'request', facilitator: 'https://channels.openzeppelin.com/x402/testnet' },
      'mpp-charge': { amount: '0.0008', per: 'request' },
    },
    regions: ['IAD', 'AMS'],
    latency_hints: { IAD: 14, AMS: 22 },
    categories: ['data/price/crypto'],
  })
}

/** Same shape as apps/provider-b/src/manifest.ts (session modes). */
function providerBShaped(): RouteDockManifest {
  return manifest({
    name: 'Streaming Provider',
    modes: ['mpp-session', 'mpp-session-ws'],
    pricing: {
      'mpp-session': {
        rate: '0.0001',
        per: 'voucher',
        channel_factory: CHANNEL_FACTORY,
        min_deposit: '0.10',
        refund_waiting_period_ledgers: 17280,
      },
      'mpp-session-ws': {
        rate: '0.0001',
        per: 'voucher',
        channel_factory: CHANNEL_FACTORY,
        min_deposit: '0.10',
        refund_waiting_period_ledgers: 17280,
      },
    },
  })
}

function withPricing(mode: string, patch: Record<string, unknown>): RouteDockManifest {
  const base = manifest() as unknown as { pricing: Record<string, Record<string, unknown>> }
  return manifest({ pricing: { ...base.pricing, [mode]: { ...base.pricing[mode], ...patch } } })
}

function startTestServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((res) => server.close(() => res())),
      })
    })
  })
}

async function serving<T>(body: unknown, fn: (url: string) => Promise<T>): Promise<T> {
  const server = await startTestServer((req, res) => {
    if (req.url === '/.well-known/routedock.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  try {
    return await fn(server.url)
  } finally {
    await server.close()
  }
}

const BAD_AMOUNTS = ['abc', '0.00000001', '-1', ''] as const

/** modes: ['x402'] with only mpp-charge priced. */
function missingPricing(): RouteDockManifest {
  return signManifest(
    manifest({ modes: ['x402'], pricing: { 'mpp-charge': { amount: '0.0008', per: 'request' } } }),
    PAYEE.secret(),
  )
}

describe('assertManifestValid — pricing vs modes', () => {
  it('rejects a mode that has no pricing entry, naming the mode', () => {
    assert.throws(
      () => assertManifestValid(missingPricing(), 'https://p.example'),
      (err: unknown) => {
        assert.ok(err instanceof RouteDockManifestError)
        assert.match(err.message, /^Invalid manifest at https:\/\/p\.example: /)
        assert.match(err.message, /mode 'x402' is listed in modes but pricing\.x402 is missing/)
        return true
      },
    )
  })

  for (const mode of ['x402', 'mpp-charge', 'mpp-session', 'mpp-session-ws'] as const) {
    it(`rejects a missing pricing.${mode}`, () => {
      const base = manifest() as unknown as { pricing: Record<string, unknown> }
      const { [mode]: _dropped, ...rest } = base.pricing
      assert.throws(
        () => assertManifestValid(manifest({ pricing: rest })),
        new RegExp(`mode '${mode}' is listed in modes but pricing\\.${mode} is missing`),
      )
    })
  }

  it('allows pricing for a mode that is not in modes', () => {
    assert.doesNotThrow(() => assertManifestValid(manifest({ modes: ['x402'] })))
  })
})

describe('assertManifestValid — deprecated_modes', () => {
  it('rejects a deprecated mode that is not in modes', () => {
    assert.throws(
      () => assertManifestValid(manifest({ modes: ['x402'], deprecated_modes: ['mpp-charge'] })),
      (err: unknown) => {
        assert.ok(err instanceof RouteDockManifestError)
        assert.match(err.message, /deprecated_modes entry 'mpp-charge' is not listed in modes/)
        return true
      },
    )
  })

  it('accepts deprecated modes that are all in modes', () => {
    assert.doesNotThrow(() =>
      assertManifestValid(manifest({ modes: ['x402', 'mpp-charge'], deprecated_modes: ['mpp-charge'] })),
    )
  })
})

describe('assertManifestValid — amounts', () => {
  const cases: Array<[string, string]> = [
    ['x402', 'amount'],
    ['mpp-charge', 'amount'],
    ['mpp-session', 'rate'],
    ['mpp-session', 'min_deposit'],
    ['mpp-session-ws', 'rate'],
    ['mpp-session-ws', 'min_deposit'],
  ]
  for (const [mode, field] of cases) {
    for (const bad of BAD_AMOUNTS) {
      it(`rejects pricing.${mode}.${field} = ${JSON.stringify(bad)} with the RangeError as cause`, () => {
        assert.throws(
          () => assertManifestValid(withPricing(mode, { [field]: bad })),
          (err: unknown) => {
            assert.ok(err instanceof RouteDockManifestError)
            assert.match(err.message, new RegExp(`pricing\\.${mode}\\.${field} `))
            assert.ok(err.cause instanceof RangeError, `cause should be RangeError, got ${String(err.cause)}`)
            return true
          },
        )
      })
    }
  }

  it('accepts the boundary values 7 fractional digits and a whole number', () => {
    assert.doesNotThrow(() => assertManifestValid(withPricing('x402', { amount: '0.0000001' })))
    assert.doesNotThrow(() => assertManifestValid(withPricing('x402', { amount: '5' })))
  })
})

describe('assertManifestValid — existing provider shapes still pass', () => {
  it('accepts a manifest shaped like apps/provider-a', () => {
    assert.doesNotThrow(() => assertManifestValid(providerAShaped()))
  })
  it('accepts a manifest shaped like apps/provider-b', () => {
    assert.doesNotThrow(() => assertManifestValid(providerBShaped()))
  })
})

describe('schema patterns (Ajv)', () => {
  const ajv = new Ajv()
  addFormats(ajv)
  const validate = ajv.compile(schema)
  const ok = (m: unknown) => validate(m) === true

  it('accepts the valid fixtures', () => {
    assert.ok(ok(manifest()), JSON.stringify(validate.errors))
    assert.ok(ok(providerAShaped()), JSON.stringify(validate.errors))
    assert.ok(ok(providerBShaped()), JSON.stringify(validate.errors))
  })

  it('rejects a bad top-level payee', () => {
    for (const payee of [PLACEHOLDER_PAYEE, 'GAAAA', ASSET_CONTRACT, PAYEE.publicKey().toLowerCase()]) {
      assert.equal(ok(manifest({ payee })), false, payee)
    }
  })

  it('rejects a bad pricing.*.payee override', () => {
    for (const mode of ['x402', 'mpp-charge']) {
      assert.equal(ok(withPricing(mode, { payee: PLACEHOLDER_PAYEE })), false, mode)
      assert.equal(ok(withPricing(mode, { payee: OTHER_PAYEE })), true, mode)
    }
  })

  it('rejects a bad asset_contract', () => {
    for (const asset_contract of ['CTESTASSETCONTRACT', PLACEHOLDER_PAYEE, OTHER_PAYEE]) {
      assert.equal(ok(manifest({ asset_contract })), false, asset_contract)
    }
  })

  it('rejects a bad channel_factory', () => {
    for (const mode of ['mpp-session', 'mpp-session-ws']) {
      for (const channel_factory of ['CTESTCHANNELFACTORY', OTHER_PAYEE]) {
        assert.equal(ok(withPricing(mode, { channel_factory })), false, `${mode} ${channel_factory}`)
      }
    }
  })

  it('rejects bad amounts, rates and deposits', () => {
    const fields: Array<[string, string]> = [
      ['x402', 'amount'],
      ['mpp-charge', 'amount'],
      ['mpp-session', 'rate'],
      ['mpp-session', 'min_deposit'],
      ['mpp-session-ws', 'rate'],
      ['mpp-session-ws', 'min_deposit'],
    ]
    for (const [mode, field] of fields) {
      for (const bad of BAD_AMOUNTS) {
        assert.equal(ok(withPricing(mode, { [field]: bad })), false, `${mode}.${field}=${bad}`)
      }
    }
  })
})

describe('fetchManifest — typed errors for malformed manifests', () => {
  it('rejects a mode without pricing with a RouteDockManifestError naming the mode', async () => {
    await serving(missingPricing(), async (url) => {
      await assert.rejects(fetchManifest(url), (err: unknown) => {
        assert.ok(err instanceof RouteDockManifestError)
        assert.match(err.message, /x402/)
        return true
      })
    })
  })

  it('rejects a payee of "G..." with a RouteDockManifestError, not a bare Error', async () => {
    const unsigned = manifest({ payee: PLACEHOLDER_PAYEE })
    await serving(unsigned, async (url) => {
      await assert.rejects(fetchManifest(url), (err: unknown) => {
        assert.ok(err instanceof RouteDockManifestError, `got ${String(err)}`)
        return true
      })
    })
  })

  it('rejects a deprecated mode that is not in modes', async () => {
    const signed = signManifest(
      manifest({ modes: ['x402'], deprecated_modes: ['mpp-charge'] }),
      PAYEE.secret(),
    )
    await serving(signed, async (url) => {
      await assert.rejects(fetchManifest(url), RouteDockManifestError)
    })
  })

  for (const bad of BAD_AMOUNTS) {
    it(`rejects pricing.x402.amount = ${JSON.stringify(bad)}`, async () => {
      const signed = signManifest(withPricing('x402', { amount: bad }), PAYEE.secret())
      await serving(signed, async (url) => {
        await assert.rejects(fetchManifest(url), RouteDockManifestError)
      })
    })
  }
})

describe('RouteDockClient — no raw TypeError from a bad manifest', () => {
  it('estimateCost() rejects with a RouteDockError for a mode without pricing', async () => {
    await serving(missingPricing(), async (url) => {
      const client = new RouteDockClient({ wallet: Keypair.random(), network: 'testnet' })
      await assert.rejects(client.estimateCost(`${url}/price`), (err: unknown) => {
        assert.ok(err instanceof RouteDockError, `got ${String(err)}`)
        assert.ok(!(err instanceof TypeError))
        return true
      })
    })
  })

  it('pay() rejects with a RouteDockError for a mode without pricing', async () => {
    await serving(missingPricing(), async (url) => {
      const client = new RouteDockClient({ wallet: Keypair.random(), network: 'testnet' })
      await assert.rejects(client.pay(`${url}/price`), (err: unknown) => {
        assert.ok(err instanceof RouteDockError, `got ${String(err)}`)
        assert.ok(!(err instanceof TypeError))
        return true
      })
    })
  })

  it('preflight(manifest) throws RouteDockManifestError for the same manifest object', async () => {
    const client = new RouteDockClient({ wallet: Keypair.random(), network: 'testnet' })
    await assert.rejects(client.preflight(missingPricing()), RouteDockManifestError)
  })
})

describe('verifyManifestSignature — malformed payee', () => {
  it('throws RouteDockSignatureError, not a bare Error, for payee "G..."', () => {
    const signed = signManifest(manifest(), PAYEE.secret())
    assert.throws(
      () => verifyManifestSignature({ ...signed, payee: PLACEHOLDER_PAYEE }),
      (err: unknown) => {
        assert.ok(err instanceof RouteDockSignatureError)
        assert.match(err.message, /not a valid Stellar public key/)
        assert.ok(err.cause !== undefined, 'original error kept as cause')
        return true
      },
    )
  })
})
