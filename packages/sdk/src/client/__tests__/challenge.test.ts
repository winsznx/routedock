import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { PaymentRequirements } from '@x402/core/types'
import type { RouteDockManifest } from '../../types.js'
import { RouteDockPolicyRejectError } from '../../errors.js'
import { checkX402Accept, filterX402Accepts, checkChargeChallenge } from '../challenge.js'

const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const PAYEE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const X402_PAYEE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAX402'
const CHARGE_PAYEE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACHARGE'

function manifest(overrides: Partial<RouteDockManifest> = {}): RouteDockManifest {
  return {
    routedock: '1.0',
    name: 'Challenge Test',
    description: 'unit test',
    modes: ['x402', 'mpp-charge'],
    network: 'testnet',
    asset: 'USDC',
    asset_contract: ASSET_CONTRACT,
    payee: PAYEE,
    pricing: {
      x402: { amount: '0.01', per: 'request', facilitator: 'https://facilitator.test' },
      'mpp-charge': { amount: '0.0008', per: 'request' },
    },
    endpoints: {},
    tags: ['test'],
    ...overrides,
  }
}

function accept(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: 'exact',
    network: 'stellar:testnet',
    asset: ASSET_CONTRACT,
    amount: '100000',
    payTo: PAYEE,
    maxTimeoutSeconds: 60,
    extra: { areFeesSponsored: true },
    ...overrides,
  }
}

function reason(err: RouteDockPolicyRejectError | null): string | undefined {
  return err?.reason
}

describe('checkX402Accept', () => {
  it('accepts a matching requirement', () => {
    assert.equal(checkX402Accept(accept(), manifest(), 'stellar:testnet'), null)
  })

  it('rejects when the amount exceeds the manifest price', () => {
    const err = checkX402Accept(accept({ amount: '10000000000' }), manifest(), 'stellar:testnet')
    assert.equal(reason(err), 'challenge_amount_exceeds_manifest')
  })

  it('accepts an amount at or below the manifest price', () => {
    assert.equal(checkX402Accept(accept({ amount: '100000' }), manifest(), 'stellar:testnet'), null)
    assert.equal(checkX402Accept(accept({ amount: '50000' }), manifest(), 'stellar:testnet'), null)
  })

  it('rejects a non-string, negative or fractional amount with challenge_amount_invalid', () => {
    for (const amount of ['1.5', '-1', 'abc', '0', '01']) {
      const err = checkX402Accept(accept({ amount }), manifest(), 'stellar:testnet')
      assert.equal(reason(err), 'challenge_amount_invalid', `amount ${amount}`)
    }
  })

  it('rejects a payee mismatch, including per-mode overrides', () => {
    const err = checkX402Accept(accept({ payTo: CHARGE_PAYEE }), manifest(), 'stellar:testnet')
    assert.equal(reason(err), 'challenge_payee_mismatch')

    const withOverride = manifest({
      pricing: {
        x402: { amount: '0.01', per: 'request', payee: X402_PAYEE },
        'mpp-charge': { amount: '0.0008', per: 'request' },
      },
    })
    assert.equal(reason(checkX402Accept(accept({ payTo: PAYEE }), withOverride, 'stellar:testnet')), 'challenge_payee_mismatch')
    assert.equal(checkX402Accept(accept({ payTo: X402_PAYEE }), withOverride, 'stellar:testnet'), null)
  })

  it('rejects asset and network mismatches', () => {
    assert.equal(
      reason(checkX402Accept(accept({ asset: PAYEE }), manifest(), 'stellar:testnet')),
      'challenge_asset_mismatch',
    )
    assert.equal(
      reason(checkX402Accept(accept({ network: 'stellar:pubnet' }), manifest(), 'stellar:testnet')),
      'challenge_network_mismatch',
    )
  })
})

describe('filterX402Accepts', () => {
  it('keeps only the matching entry from a bad-then-good list', () => {
    const bad = accept({ amount: '10000000000' })
    const good = accept({ amount: '50000' })
    const allowed = filterX402Accepts([bad, good], manifest(), 'stellar:testnet')
    assert.equal(allowed.length, 1)
    assert.equal(allowed[0]!.amount, '50000')
  })

  it('returns empty when nothing matches', () => {
    assert.deepEqual(filterX402Accepts([accept({ amount: '999999999' })], manifest(), 'stellar:testnet'), [])
  })
})

describe('checkChargeChallenge', () => {
  const request = {
    amount: '8000',
    currency: ASSET_CONTRACT,
    recipient: PAYEE,
  }

  it('accepts a matching challenge (network defaults to testnet)', () => {
    assert.equal(checkChargeChallenge(request, manifest(), 'stellar:testnet'), null)
  })

  it('rejects an inflated amount', () => {
    assert.equal(
      reason(checkChargeChallenge({ ...request, amount: '8000000000' }, manifest(), 'stellar:testnet')),
      'challenge_amount_exceeds_manifest',
    )
  })

  it('rejects non-integer amounts without throwing a raw SyntaxError', () => {
    assert.equal(
      reason(checkChargeChallenge({ ...request, amount: 'abc' }, manifest(), 'stellar:testnet')),
      'challenge_amount_invalid',
    )
    assert.equal(
      reason(checkChargeChallenge({ ...request, amount: '-5' }, manifest(), 'stellar:testnet')),
      'challenge_amount_invalid',
    )
  })

  it('rejects a swapped recipient or currency', () => {
    assert.equal(
      reason(checkChargeChallenge({ ...request, recipient: CHARGE_PAYEE }, manifest(), 'stellar:testnet')),
      'challenge_payee_mismatch',
    )
    assert.equal(
      reason(checkChargeChallenge({ ...request, currency: PAYEE }, manifest(), 'stellar:testnet')),
      'challenge_asset_mismatch',
    )
  })

  it('rejects a mismatched methodDetails.network', () => {
    assert.equal(
      reason(
        checkChargeChallenge(
          { ...request, methodDetails: { network: 'stellar:pubnet' } },
          manifest(),
          'stellar:testnet',
        ),
      ),
      'challenge_network_mismatch',
    )
    assert.equal(
      checkChargeChallenge(
        { ...request, methodDetails: { network: 'stellar:testnet' } },
        manifest(),
        'stellar:testnet',
      ),
      null,
    )
  })

  it('honors per-mode payee overrides', () => {
    const withOverride = manifest({
      pricing: {
        x402: { amount: '0.01', per: 'request' },
        'mpp-charge': { amount: '0.0008', per: 'request', payee: CHARGE_PAYEE },
      },
    })
    assert.equal(
      reason(checkChargeChallenge(request, withOverride, 'stellar:testnet')),
      'challenge_payee_mismatch',
    )
    assert.equal(
      checkChargeChallenge({ ...request, recipient: CHARGE_PAYEE }, withOverride, 'stellar:testnet'),
      null,
    )
  })
})
