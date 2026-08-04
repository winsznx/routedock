export interface VaultSettlementAddresses {
  payer: string
  payee: string
}

/**
 * Return correctly attributed vault-event participants, or null when the
 * payer could not be extracted. Publishing no audit event is safer than
 * knowingly attributing the provider as both sides of the settlement.
 */
export function resolveVaultSettlementAddresses(
  payer: string | null,
  payee: string,
): VaultSettlementAddresses | null {
  if (!payer) return null
  return { payer, payee }
}