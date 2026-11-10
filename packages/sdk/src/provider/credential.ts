import { Credential } from 'mppx'

export interface ParsedMppCredentialPayload {
  action?: unknown
  amount?: unknown
  signature?: unknown
  transaction?: unknown
  [key: string]: unknown
}

export type ParsedMppCredential = Credential.Credential<ParsedMppCredentialPayload>

/**
 * Best-effort parser for an MPP `Authorization: Payment <base64url>` header
 * built on mppx's own `Credential` codec (`extractPaymentScheme` +
 * `deserialize`). Returns `null` when the header is missing, does not carry a
 * `Payment` scheme, or fails to deserialize.
 */
export function parseMppCredential(
  header: string | undefined | null,
): ParsedMppCredential | null {
  if (!header || typeof header !== 'string') return null
  try {
    const payment = Credential.extractPaymentScheme(header)
    if (!payment) return null
    return Credential.deserialize<ParsedMppCredentialPayload>(payment)
  } catch {
    return null
  }
}

export { parseMppCredential as parseCredential }
