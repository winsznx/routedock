import { StrKey } from '@stellar/stellar-sdk'

/**
 * Return a validated Stellar payer address from a decoded credential field.
 *
 * Provider callbacks accept classic G... accounts and muxed M... accounts.
 * Invalid strings are ignored so attribution stays best-effort and never blocks
 * settlement.
 */
export function extractPayerAddress(key: unknown): string | null {
  if (typeof key !== 'string') return null
  let value = key
  const didAccount = value.match(/(?:^|:)((?:G|M)[A-Z2-7]{55})$/)?.[1]
  if (didAccount) value = didAccount

  return StrKey.isValidEd25519PublicKey(value) || StrKey.isValidMed25519PublicKey(value)
    ? value
    : null
}
