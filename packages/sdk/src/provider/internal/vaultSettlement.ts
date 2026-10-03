import {
  Account,
  BASE_FEE,
  Contract,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
} from '@stellar/stellar-sdk'

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

/**
 * Build the `record_session_settlement` transaction for a closed channel.
 *
 * The transaction source is the payee, because the vault authorizes the record
 * with the allowlisted payee's own signature — never the vault admin's. The
 * source-account credential added by `prepareTransaction` therefore satisfies
 * `payee.require_auth()` on the contract, so a provider never needs the admin
 * secret to emit `session_settled`.
 *
 * Kept free of RPC calls so it is unit-testable without a network round trip.
 */
export function buildSessionSettlementTransaction(
  source: Account,
  vaultContractId: string,
  channelId: string,
  addresses: VaultSettlementAddresses,
  amount: bigint,
  voucherCount: number,
  networkPassphrase: string,
): Transaction {
  const vault = new Contract(vaultContractId)
  const op = vault.call(
    'record_session_settlement',
    nativeToScVal(channelId, { type: 'address' }),
    nativeToScVal(addresses.payer, { type: 'address' }),
    nativeToScVal(addresses.payee, { type: 'address' }),
    nativeToScVal(amount, { type: 'i128' }),
    nativeToScVal(voucherCount, { type: 'u32' }),
  )
  return new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(30)
    .build()
}