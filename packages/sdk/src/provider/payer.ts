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

  return StrKey.isValidEd25519PublicKey(key) || StrKey.isValidMed25519PublicKey(key)
    ? key
    : null
}
