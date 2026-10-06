import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { selectMode } from '../ModeRouter.js'
import { RouteDockPolicyRejectError } from '../../errors.js'
import type { RouteDockManifest } from '../../types.js'

function createManifest(
  pricing: RouteDockManifest['pricing'],
  modes: RouteDockManifest['modes'] = ['x402', 'mpp-charge'],
): RouteDockManifest {
  return {
    routedock: '1.0',
    name: 'Budget Test Provider',
    description: 'Manifest used to verify budget_per_request validation',
    modes,
    network: 'testnet',
    asset: 'USDC',
    asset_contract: 'CTESTASSETCONTRACT',
    payee: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    pricing,
    endpoints: {},
    tags: ['test'],
  }
}

/** x402 costs 0.005, mpp-charge costs 0.001 — mpp-charge is cheapest. */
const manifest = createManifest({
  x402: { amount: '0.005', per: 'request' },
  'mpp-charge': { amount: '0.001', per: 'request' },
})

function assertPolicyReject(reason: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof RouteDockPolicyRejectError)
    assert.equal(error.code, 'POLICY_REJECT')
    assert.equal(error.reason, reason)
    return true
  }
}

describe('selectMode — budget_per_request validation', () => {
  for (const invalid of ['abc', '$0.01', '', '   ', '1.2.3', '-0.01', '0.00000001']) {
    it(`throws invalid_budget_per_request for ${JSON.stringify(invalid)}`, () => {
      assert.throws(
        () => selectMode(manifest, { optimize: 'cost', budget_per_request: invalid }),
        assertPolicyReject('invalid_budget_per_request'),
      )
    })
  }

  it('validates the budget before selecting a mode (returns no mode)', () => {
    let selected: string | undefined
    assert.throws(() => {
      selected = selectMode(manifest, { optimize: 'cost', budget_per_request: 'abc' })
    }, assertPolicyReject('invalid_budget_per_request'))
    assert.equal(selected, undefined)
  })

  it('throws budget_per_request_exceeded when the ceiling is below every price', () => {
    assert.throws(
      () => selectMode(manifest, { optimize: 'cost', budget_per_request: '0.0005' }),
      assertPolicyReject('budget_per_request_exceeded'),
    )
  })

  it('returns the cheapest affordable mode at the exact ceiling', () => {
    assert.equal(
      selectMode(manifest, { optimize: 'cost', budget_per_request: '0.001' }),
      'mpp-charge',
    )
  })

  it('returns the cheapest affordable mode above the ceiling', () => {
    assert.equal(
      selectMode(manifest, { optimize: 'cost', budget_per_request: '0.01' }),
      'mpp-charge',
    )
  })

  it('compares budget and price exactly rather than by float approximation', () => {
    const cheapX402 = createManifest({
      x402: { amount: '0.1', per: 'request' },
      'mpp-charge': { amount: '0.3', per: 'request' },
    })
    // '0.1' must be affordable against a '0.1' ceiling exactly.
    assert.equal(
      selectMode(cheapX402, { optimize: 'cost', budget_per_request: '0.1' }),
      'x402',
    )
    // A ceiling one stroop below the cheaper price excludes it.
    assert.throws(
      () => selectMode(cheapX402, { optimize: 'cost', budget_per_request: '0.0999999' }),
      assertPolicyReject('budget_per_request_exceeded'),
    )
  })

  it('selects the cheapest mode with no ceiling when budget is omitted', () => {
    assert.equal(selectMode(manifest, { optimize: 'cost' }), 'mpp-charge')
  })

  it('ignores the budget when optimize is not cost', () => {
    assert.equal(
      selectMode(manifest, { budget_per_request: 'abc' }),
      'mpp-charge',
    )
  })
})
