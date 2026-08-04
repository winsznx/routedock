import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import { resolveVaultSettlementAddresses } from '../internal/vaultSettlement.js'

describe('vault session settlement attribution', () => {
  it('uses the captured session payer and provider payee as distinct participants', () => {
    const payer = Keypair.random().publicKey()
    const payee = Keypair.random().publicKey()

    assert.deepEqual(resolveVaultSettlementAddresses(payer, payee), { payer, payee })
  })

  it('returns null instead of substituting the provider when payer extraction failed', () => {
    const payee = Keypair.random().publicKey()

    assert.equal(resolveVaultSettlementAddresses(null, payee), null)
  })
})