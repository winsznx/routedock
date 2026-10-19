/**
 * USDC decimal-to-integer conversion shared by nulth-sdk and @routedock/routedock.
 *
 * 1 USDC = 10^7 stroops on Stellar. This is the single canonical converter;
 * callers in other packages re-export it rather than reimplementing the math.
 */

export const USDC_DECIMALS = 7
const USDC_SCALE = 10n ** BigInt(USDC_DECIMALS)

/**
 * Parse a decimal USDC string (e.g. "1.00", "0.0001") into exact stroops
 * (10^-7 USDC) as a bigint, with no floating-point arithmetic.
 *
 * Float math drifts: summing many small amounts in `number` USDC
 * (e.g. 7000 × 0.0001) yields 0.7000000000000006 instead of 0.7, which silently
 * overruns a spend cap on every boundary crossing. Comparing and accumulating in
 * this integer domain is exact.
 *
 * Throws RangeError on malformed input, negatives, precision finer than
 * {@link USDC_DECIMALS} decimals, or values too large to represent exactly.
 */
export function usdcToStroops(amount: string): bigint {
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
  const fracUnits = BigInt(frac.padEnd(USDC_DECIMALS, '0'))
  const units = BigInt(whole) * USDC_SCALE + fracUnits
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`USDC amount "${amount}" is too large to represent exactly`)
  }
  return units
}

/**
 * Inverse of {@link usdcToStroops}: format exact stroops (10^-7 USDC) as a
 * canonical decimal USDC string, with no trailing zeros.
 *
 * `stroopsToUsdc(usdcToStroops(x)) === x` holds for canonical inputs (the form
 * this function outputs). Used to report the amount actually signed by a
 * payment client, which may be less than the manifest price.
 *
 * Throws RangeError on negative units (there is no such thing as a negative
 * transfer amount).
 */
export function stroopsToUsdc(units: bigint): string {
  if (units < 0n) {
    throw new RangeError(`Invalid USDC stroops: "${units.toString()}" is negative`)
  }
  const whole = units / USDC_SCALE
  const frac = units % USDC_SCALE
  if (frac === 0n) return whole.toString()
  const fracStr = frac.toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '')
  return `${whole.toString()}.${fracStr}`
}
