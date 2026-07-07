/** Stellar USDC precision: 1 USDC = 10^7 base units. */
export const USDC_DECIMALS = 7
const USDC_SCALE = 10 ** USDC_DECIMALS

/**
 * Parse a decimal USDC string (e.g. "1.00", "0.0001") into exact integer
 * microUSDC units (10^-7 USDC), with no floating-point arithmetic.
 *
 * Float math drifts: summing many small amounts in `number` USDC
 * (e.g. 7000 × 0.0001) yields 0.7000000000000006 instead of 0.7, which silently
 * overruns a spend cap on every boundary crossing. Comparing and accumulating in
 * this integer domain is exact.
 *
 * Throws on malformed input or precision finer than {@link USDC_DECIMALS} decimals.
 */
export function usdcToUnits(amount: string): number {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim())
  if (!match) {
    throw new RangeError(`Invalid USDC amount: "${amount}"`)
  }
  const whole = match[1]!
  const frac = match[2] ?? ''
  if (frac.length > USDC_DECIMALS) {
    throw new RangeError(
      `USDC amount "${amount}" exceeds ${USDC_DECIMALS} decimals of precision`,
    )
  }
  const fracUnits = Number(frac.padEnd(USDC_DECIMALS, '0'))
  const units = Number(whole) * USDC_SCALE + fracUnits
  if (!Number.isSafeInteger(units)) {
    throw new RangeError(`USDC amount "${amount}" is too large to represent exactly`)
  }
  return units
}
