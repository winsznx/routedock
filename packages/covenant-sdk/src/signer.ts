import type { SignAuthEntry } from '@stellar/stellar-sdk/contract'
import {
  authDigestFromEntry,
  commitAllowlist,
  commitDailyCap,
  dayBucket,
  encodeAuthSignature,
  hashPayee,
  mockGroth16Proof,
  usdcToStroops,
} from './proof.js'
import { CovenantClient } from './CovenantClient.js'
import type { CovenantClientConfig, PaymentAuthContext } from './types.js'

/** Compatible with @x402/stellar ClientStellarSigner */
export interface CovenantStellarSigner {
  address: string
  signAuthEntry: SignAuthEntry
}

export interface CovenantSignerConfig extends CovenantClientConfig {
  /** Pending payment context set before x402 signs auth entries */
  paymentContext?: Omit<PaymentAuthContext, 'authEntry'>
}

/**
 * Create an x402-compatible signer that pays from a Covenant ZK account.
 * Proofs are built off-chain; allowlist and cap never leave the agent.
 */
export function createCovenantSigner(config: CovenantSignerConfig): CovenantStellarSigner {
  const client = new CovenantClient(config)
  const covenantAccount = config.covenantAccount

  return {
    address: covenantAccount,
    signAuthEntry: async (authEntry) => {
      const ctx = config.paymentContext
      if (!ctx) {
        throw new Error(
          'Covenant paymentContext must be set before signing — call setCovenantPaymentContext()',
        )
      }

      const proof = client.buildPaymentAuthProof({
        authEntry,
        ...ctx,
      })

      return {
        signedAuthEntry: encodeAuthSignature(proof),
        signerAddress: covenantAccount,
      }
    },
  }
}

/** Bind the next payment's public context before x402 calls signAuthEntry */
export function setCovenantPaymentContext(
  config: CovenantSignerConfig,
  context: Omit<PaymentAuthContext, 'authEntry'>,
): void {
  config.paymentContext = context
}

/** Helper to prepare payment context from manifest pricing */
export function paymentContextFromManifest(
  manifest: {
    payee: string
    asset_contract: string
    pricing: { x402?: { amount: string }; 'mpp-charge'?: { amount: string } }
  },
  mode: 'x402' | 'mpp-charge',
  ledgerSequence: number,
): Omit<PaymentAuthContext, 'authEntry'> {
  const pricing = manifest.pricing[mode]
  if (!pricing) {
    throw new Error(`manifest.pricing.${mode} missing`)
  }
  return {
    payee: manifest.payee,
    amountStroops: usdcToStroops(pricing.amount),
    assetContract: manifest.asset_contract,
    ledgerSequence,
  }
}

/** Initialize off-chain policy from explicit allowlist + cap (hashed before use) */
export function createPolicyState(input: {
  dailyCapUsdc: string
  allowedPayees: readonly string[]
  witnessSecret: string
  expiryLedger?: number
  ledgerSequence?: number
}): import('./types.js').CovenantPolicyState {
  const dailyCapStroops = usdcToStroops(input.dailyCapUsdc)
  const witnessSecret = input.witnessSecret
  return {
    dailyCapStroops,
    allowlistCommitment: commitAllowlist(input.allowedPayees, witnessSecret),
    allowedPayees: input.allowedPayees,
    dailySpendStroops: 0n,
    dayBucket: dayBucket(input.ledgerSequence ?? 0),
    witnessSecret,
    ...(input.expiryLedger !== undefined ? { expiryLedger: input.expiryLedger } : {}),
  }
}

export {
  authDigestFromEntry,
  commitAllowlist,
  commitDailyCap,
  dayBucket,
  hashPayee,
  mockGroth16Proof,
  usdcToStroops,
}
