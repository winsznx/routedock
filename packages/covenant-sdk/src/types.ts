/**
 * Off-chain policy state for a Covenant ZK account.
 * Allowlist and daily cap live here — never published on-chain.
 */
export interface CovenantPolicyState {
  /** Maximum daily spend in stroops (7-decimal USDC) */
  dailyCapStroops: bigint
  /** SHA-256 commitment to sorted allowlisted payee addresses (hex) */
  allowlistCommitment: string
  /** Allowed payee contract/account addresses — kept off-chain */
  allowedPayees: readonly string[]
  /** Cumulative spend for the current day bucket */
  dailySpendStroops: bigint
  /** Ledger day bucket: ledger_sequence / 17280 */
  dayBucket: number
  /** Agent witness secret — binds proofs without exposing policy */
  witnessSecret: string
  /** Optional session expiry ledger */
  expiryLedger?: number
}

/** Inputs for building a payment authorization proof */
export interface PaymentAuthContext {
  /** Base64 Soroban auth entry preimage from x402 / RouteDock */
  authEntry: string
  /** Destination payee address (G... or C...) */
  payee: string
  /** Transfer amount in stroops */
  amountStroops: bigint
  /** SAC asset contract address */
  assetContract: string
  /** Current ledger sequence (for day bucket + expiry checks) */
  ledgerSequence: number
}

/** ZK auth proof attached to Soroban __check_auth */
export interface CovenantZkProof {
  version: 1
  /** Groth16-style proof bytes (base64) — verified on-chain, policy stays private */
  proof: string
  /** Public inputs bound into the proof (no raw allowlist or cap values) */
  publicInputs: {
    authDigest: string
    allowlistCommitment: string
    capCommitment: string
    payeeHash: string
    amountStroops: string
    dayBucket: string
  }
}

/** Encoded signature payload for SorobanAddressCredentials.signature */
export interface CovenantAuthSignature {
  covenant: 'zk-v1'
  proof: CovenantZkProof
}

export interface CovenantClientConfig {
  /** Covenant smart account contract address (C...) — the payer */
  covenantAccount: string
  /** Off-chain policy state */
  policy: CovenantPolicyState
  /** Optional verifier contract deployed alongside the Covenant account */
  verifierContract?: string
}

export class CovenantPolicyError extends Error {
  readonly code: 'payee_not_allowed' | 'daily_cap_exceeded' | 'session_expired'

  constructor(code: CovenantPolicyError['code'], message: string) {
    super(message)
    this.name = 'CovenantPolicyError'
    this.code = code
  }
}
