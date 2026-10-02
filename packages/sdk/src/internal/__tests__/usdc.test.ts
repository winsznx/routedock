import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { usdcToStroops, stroopsToUsdc, usdcToUnits, USDC_DECIMALS } from '../usdc.js'

/**
 * Shared acceptance table for the USDC → stroops converter. Mirrors the table
 * exercised against nulth-sdk's canonical implementation — both packages must
 * agree on every row, because the SDK re-exports the nulth-sdk converter.
 */
const VALID: Array<[input: string, stroops: bigint]> = [
  ['1.00', 10_000_000n],
  ['0.0001', 1_000n],
  ['0.0000001', 1n],
  ['0', 0n],
  ['  2.5  ', 25_000_000n],
  ['0001.0000000', 10_000_000n], // leading zeros preserved
  ['900719925.4740991', 9_007_199_254_740_991n], // safe-integer boundary
]

const INVALID = [
  'abc',
  '1.2.3',
  '-1', // negatives rejected
  '0.00000001', // over-precision (8 decimals)
  '', // empty string
  '   ', // whitespace only
  '1e-7', // scientific notation rejected
  '900719925.4740992', // unsafe integer (MAX_SAFE_INTEGER + 1)
]

describe('usdcToStroops (canonical converter)', () => {
  it('converts valid decimal strings to exact bigint stroops', () => {
    assert.equal(USDC_DECIMALS, 7)
    for (const [input, expected] of VALID) {
      assert.equal(usdcToStroops(input), expected, `usdcToStroops(${JSON.stringify(input)})`)
    }
  })

  it('rejects negatives, over-precision, empty, scientific and unsafe inputs', () => {
    for (const input of INVALID) {
      assert.throws(() => usdcToStroops(input), RangeError, `should reject ${JSON.stringify(input)}`)
    }
  })

  it('accumulates exactly where float addition drifts', () => {
    let total = 0n
    const unit = usdcToStroops('0.0001')
    for (let i = 0; i < 7000; i++) total += unit
    assert.equal(total, usdcToStroops('0.7'))
    assert.equal(total <= usdcToStroops('0.7'), true)
  })

  it('usdcToUnits is a thin alias for the same converter', () => {
    for (const [input, expected] of VALID) {
      assert.equal(usdcToUnits(input), expected)
    }
  })
})

describe('stroopsToUsdc (inverse converter)', () => {
  it('round-trips canonical decimal amounts exactly', () => {
    for (const canonical of ['0.0001', '1', '123.4567891', '0.005', '900719925.4740991']) {
      assert.equal(
        stroopsToUsdc(usdcToStroops(canonical)),
        canonical,
        `stroopsToUsdc(usdcToStroops(${JSON.stringify(canonical)}))`,
      )
    }
  })

  it('outputs canonical strings with no trailing zeros', () => {
    assert.equal(stroopsToUsdc(10_000_000n), '1')
    assert.equal(stroopsToUsdc(1_000n), '0.0001')
    assert.equal(stroopsToUsdc(50_000n), '0.005')
    assert.equal(stroopsToUsdc(0n), '0')
  })

  it('rejects negative stroops', () => {
    assert.throws(() => stroopsToUsdc(-1n), RangeError)
  })
})
