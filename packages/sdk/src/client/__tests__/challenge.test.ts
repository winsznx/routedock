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

// The callers hand these in, exactly as they read them off manifest.pricing
// after their own presence checks.
const X402_PRICE = '0.01'
const CHARGE_PRICE = '0.0008'

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
      x402: { amount: X402_PRICE, per: 'request', facilitator: 'https://facilitator.test' },
      'mpp-charge': { amount: CHARGE_PRICE, per: 'request' },
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

function check(
  candidate: PaymentRequirements,
  m: RouteDockManifest = manifest(),
): RouteDockPolicyRejectError | null {
  return checkX402Accept(candidate, m, 'stellar:testnet', X402_PRICE)
}

function reason(err: RouteDockPolicyRejectError | null): string | undefined {
  return err?.reason
}

function charge(
  request: Record<string, unknown>,
  m: RouteDockManifest = manifest(),
): RouteDockPolicyRejectError | null {
  return checkChargeChallenge(request, m, 'stellar:testnet', CHARGE_PRICE)
}

describe('checkX402Accept', () => {
  it('accepts a matching requirement', () => {
    assert.equal(check(accept()), null)
  })

  it('rejects when the amount exceeds the manifest price', () => {
    assert.equal(reason(check(accept({ amount: '10000000000' }))), 'challenge_amount_exceeds_manifest')
  })

  it('accepts an amount at or below the manifest price', () => {
    assert.equal(check(accept({ amount: '100000' })), null)
    assert.equal(check(accept({ amount: '50000' })), null)
  })

  it('rejects a non-string, negative or fractional amount with challenge_amount_invalid', () => {
    for (const amount of ['1.5', '-1', 'abc', '0', '01']) {
      assert.equal(reason(check(accept({ amount }))), 'challenge_amount_invalid', `amount ${amount}`)
    }
  })

  it('rejects a payee mismatch, including per-mode overrides', () => {
    assert.equal(reason(check(accept({ payTo: CHARGE_PAYEE }))), 'challenge_payee_mismatch')

    const withOverride = manifest({
      pricing: {
        x402: { amount: X402_PRICE, per: 'request', payee: X402_PAYEE },
        'mpp-charge': { amount: CHARGE_PRICE, per: 'request' },
      },
    })
    assert.equal(reason(check(accept({ payTo: PAYEE }), withOverride)), 'challenge_payee_mismatch')
    assert.equal(check(accept({ payTo: X402_PAYEE }), withOverride), null)
  })

  it('rejects asset and network mismatches', () => {
    assert.equal(reason(check(accept({ asset: PAYEE }))), 'challenge_asset_mismatch')
    assert.equal(reason(check(accept({ network: 'stellar:pubnet' }))), 'challenge_network_mismatch')
  })

  it('bounds the amount by the price it was handed, not by the manifest', () => {
    // The client reads pricing.x402.amount once and passes it down; a validator
    // must not go looking for a different mode's price.
    assert.equal(
      checkX402Accept(accept({ amount: '100000' }), manifest(), 'stellar:testnet', CHARGE_PRICE)
        ?.reason,
      'challenge_amount_exceeds_manifest',
    )
  })
})

describe('filterX402Accepts', () => {
  it('keeps only the matching entry from a bad-then-good list', () => {
    const bad = accept({ amount: '10000000000' })
    const good = accept({ amount: '50000' })
    const allowed = filterX402Accepts([bad, good], manifest(), 'stellar:testnet', X402_PRICE)
    assert.equal(allowed.length, 1)
    assert.equal(allowed[0]!.amount, '50000')
  })

  it('returns empty when nothing matches', () => {
    assert.deepEqual(
      filterX402Accepts([accept({ amount: '999999999' })], manifest(), 'stellar:testnet', X402_PRICE),
      [],
    )
  })
})

describe('checkChargeChallenge', () => {
  const request = {
    amount: '8000',
    currency: ASSET_CONTRACT,
    recipient: PAYEE,
  }

  it('accepts a matching challenge (network defaults to testnet)', () => {
    assert.equal(charge(request), null)
  })

  it('rejects an inflated amount', () => {
    assert.equal(
      reason(charge({ ...request, amount: '8000000000' })),
      'challenge_amount_exceeds_manifest',
    )
  })

  it('rejects non-integer amounts without throwing a raw SyntaxError', () => {
    assert.equal(reason(charge({ ...request, amount: 'abc' })), 'challenge_amount_invalid')
    assert.equal(reason(charge({ ...request, amount: '-5' })), 'challenge_amount_invalid')
  })

  it('rejects a swapped recipient or currency', () => {
    assert.equal(reason(charge({ ...request, recipient: CHARGE_PAYEE })), 'challenge_payee_mismatch')
    assert.equal(reason(charge({ ...request, currency: PAYEE })), 'challenge_asset_mismatch')
  })

  it('rejects a mismatched methodDetails.network', () => {
    assert.equal(
      reason(charge({ ...request, methodDetails: { network: 'stellar:pubnet' } })),
      'challenge_network_mismatch',
    )
    assert.equal(charge({ ...request, methodDetails: { network: 'stellar:testnet' } }), null)
  })

  it('honors per-mode payee overrides', () => {
    const withOverride = manifest({
      pricing: {
        x402: { amount: X402_PRICE, per: 'request' },
        'mpp-charge': { amount: CHARGE_PRICE, per: 'request', payee: CHARGE_PAYEE },
      },
    })
    assert.equal(reason(charge(request, withOverride)), 'challenge_payee_mismatch')
    assert.equal(charge({ ...request, recipient: CHARGE_PAYEE }, withOverride), null)
  })
})
