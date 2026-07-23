import {
  authDigestFromEntry,
  commitDailyCap,
  dayBucket,
  encodeAuthSignature,
  hashPayee,
  mockGroth16Proof,
} from './proof.js'
import type {
  NulthClientConfig,
  NulthPolicyState,
  NulthProof,
  PaymentAuthContext,
} from './types.js'
import { NulthPolicyError } from './types.js'

export class NulthClient {
  private policy: NulthPolicyState

  constructor(private readonly config: NulthClientConfig) {
    this.policy = { ...config.policy }
  }

  get nulthAccount(): string {
    return this.config.nulthAccount
  }

  get allowlistCommitment(): string {
    return this.policy.allowlistCommitment
  }

  get capCommitment(): string {
    return commitDailyCap(this.policy.dailyCapStroops, this.policy.witnessSecret)
  }

  /** Current off-chain daily spend (never published) */
  get dailySpendStroops(): bigint {
    return this.policy.dailySpendStroops
  }

  /**
   * Build a ZK proof that the payment satisfies off-chain policy.
   * Called by RouteDock before attaching the auth signature to the tx.
   */
  buildPaymentAuthProof(context: PaymentAuthContext): NulthProof {
    this.enforcePolicy(context)

    const bucket = dayBucket(context.ledgerSequence)
    if (bucket !== this.policy.dayBucket) {
      this.policy.dayBucket = bucket
      this.policy.dailySpendStroops = 0n
    }

    const authDigest = authDigestFromEntry(context.authEntry)
    const capCommitment = this.capCommitment
    const payeeHash = hashPayee(context.payee)

    const preimage = [
      authDigest,
      this.policy.allowlistCommitment,
      capCommitment,
      payeeHash,
      context.amountStroops.toString(),
      bucket.toString(),
      this.config.nulthAccount,
    ].join('|')

    const proof: NulthProof = {
      version: 1,
      proof: mockGroth16Proof(preimage),
      publicInputs: {
        authDigest,
        allowlistCommitment: this.policy.allowlistCommitment,
        capCommitment,
        payeeHash,
        amountStroops: context.amountStroops.toString(),
        dayBucket: bucket.toString(),
      },
    }

    this.policy.dailySpendStroops += context.amountStroops
    return proof
  }

  /** Encode proof for SorobanAddressCredentials.signature */
  encodeProof(proof: NulthProof): string {
    return encodeAuthSignature(proof)
  }

  private enforcePolicy(context: PaymentAuthContext): void {
    if (
      this.policy.expiryLedger !== undefined &&
      context.ledgerSequence > this.policy.expiryLedger
    ) {
      throw new NulthPolicyError('session_expired', 'Nulth session expired')
    }

    if (!this.policy.allowedPayees.includes(context.payee)) {
      throw new NulthPolicyError(
        'payee_not_allowed',
        `Payee ${context.payee} not in off-chain allowlist`,
      )
    }

    const bucket = dayBucket(context.ledgerSequence)
    const spend =
      bucket === this.policy.dayBucket ? this.policy.dailySpendStroops : 0n
    const projected = spend + context.amountStroops
    if (projected > this.policy.dailyCapStroops) {
      throw new NulthPolicyError('daily_cap_exceeded', 'Nulth daily cap exceeded')
    }
  }
}
