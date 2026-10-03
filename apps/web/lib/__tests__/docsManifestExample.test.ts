import { describe, it, expect } from 'vitest'
import { Validator, type Schema } from '@cfworker/json-schema'
import schema from '@routedock/routedock/schema'
import { DOCS_MANIFEST_EXAMPLE } from '../docsManifestExample'

describe('DOCS_MANIFEST_EXAMPLE', () => {
  const validator = new Validator(schema as unknown as Schema, '7')

  it('validates successfully against the RouteDock manifest schema', () => {
    const result = validator.validate(DOCS_MANIFEST_EXAMPLE)
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })

  it('fails validation for the legacy example (missing description and string endpoint)', () => {
    const legacyExample = {
      routedock: '1.0',
      name: 'Stellar DEX Price Feed',
      modes: ['x402', 'mpp-charge'],
      network: 'testnet',
      asset: 'USDC',
      asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      payee: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      pricing: {
        x402: { amount: '0.001', per: 'request' },
        'mpp-charge': { amount: '0.0008', per: 'request' },
      },
      endpoints: { price: 'GET /price' },
      tags: ['price', 'stellar', 'dex'],
    }

    const result = validator.validate(legacyExample)
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })

  it('fails validation if description is missing', () => {
    const withoutDescription = { ...DOCS_MANIFEST_EXAMPLE } as Record<string, unknown>
    delete withoutDescription.description

    const result = validator.validate(withoutDescription)
    expect(result.valid).toBe(false)
  })

  it('fails validation if endpoints are string format instead of descriptor object', () => {
    const withStringEndpoint = {
      ...DOCS_MANIFEST_EXAMPLE,
      endpoints: { price: 'GET /price' },
    }

    const result = validator.validate(withStringEndpoint)
    expect(result.valid).toBe(false)
  })
})
