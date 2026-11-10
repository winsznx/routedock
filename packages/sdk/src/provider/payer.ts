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

/**
 * Extract a validated Stellar payer address (`G...` or `M...`) from a
 * `did:pkh:...` DID string (e.g. `did:pkh:stellar:testnet:G...`).
 *
 * Takes the last `:`-separated segment of a `did:pkh:...` string and validates
 * it with {@link extractPayerAddress}. Anything else returns `null`.
 */
export function payerFromDidPkh(source: unknown): string | null {
  if (typeof source !== 'string' || !source.startsWith('did:pkh:')) return null
  const segments = source.split(':')
  if (segments.length < 4) return null
  if (segments.slice(0, -1).some((s) => s.length === 0)) return null
  const last = segments[segments.length - 1]
  return extractPayerAddress(last)
}
