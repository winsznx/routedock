import type { PaymentRequirements } from '@x402/core/types'
import type { RouteDockManifest } from '../types.js'
import { RouteDockPolicyRejectError } from '../errors.js'
import { usdcToStroops } from '../internal/usdc.js'
import { resolvePayee } from '../internal/payee.js'

/**
 * Pure, RPC-free validators that bind a payment challenge (the unsigned 402
 * body) to the signed manifest before any credential is created.
 *
 * The manifest is signed by the provider's payee, but the 402 that describes
 * *what* to sign is not. A dishonest or compromised provider can serve a
 * correctly signed manifest priced at 0.0001 USDC and then demand 1000 USDC,
 * payable to any address, in any SAC token the agent holds. These validators
 * are the client-side guard: every field that ends up in the signed transfer
 * (network, payee, asset, amount) is compared against the manifest.
 */

export type Caip2Network = 'stellar:testnet' | 'stellar:pubnet'

/** Additional caller constraints applied before a challenge can be signed. */
export interface ChallengePolicyOptions {
  /** Decimal ceiling from the current pay() call. */
  maxAmount?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** A positive integer base-unit string (stroops), no leading zeros. */
function isPositiveIntegerString(value: unknown): value is string {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value)
}

/** Validate a base-unit amount against both the manifest and caller ceiling. */
function checkAmount(
  amount: unknown,
  manifestAmount: string,
  maxAmount?: string,
): RouteDockPolicyRejectError | null {
  if (!isPositiveIntegerString(amount)) {
    return new RouteDockPolicyRejectError('challenge_amount_invalid')
  }
  let manifestMax: bigint
  try {
    manifestMax = usdcToStroops(manifestAmount)
  } catch {
    return new RouteDockPolicyRejectError('challenge_amount_invalid')
  }
  const requested = BigInt(amount)
  if (requested > manifestMax) {
    return new RouteDockPolicyRejectError('challenge_amount_exceeds_manifest')
  }
  if (maxAmount !== undefined) {
    let callerMax: bigint
    try {
      callerMax = usdcToStroops(maxAmount)
    } catch {
      return new RouteDockPolicyRejectError('max_amount_invalid')
    }
    if (requested > callerMax) {
      return new RouteDockPolicyRejectError('max_amount_exceeded')
    }
  }
  return null
}

/**
 * Validate one x402 `accepts` entry against the manifest. Returns the rejection
 * to throw, or `null` when the entry is safe to sign.
 *
 * `manifestAmount` is the decimal price already read from the manifest.
 * `policy.maxAmount` additionally bounds the amount by the caller's ceiling.
 */
export function checkX402Accept(
  accept: PaymentRequirements,
  manifest: RouteDockManifest,
  network: Caip2Network,
  manifestAmount: string,
  policy?: ChallengePolicyOptions,
): RouteDockPolicyRejectError | null {
  if (accept.network !== network) {
    return new RouteDockPolicyRejectError('challenge_network_mismatch')
  }
  if (accept.payTo !== resolvePayee(manifest, 'x402')) {
    return new RouteDockPolicyRejectError('challenge_payee_mismatch')
  }
  if (accept.asset !== manifest.asset_contract) {
    return new RouteDockPolicyRejectError('challenge_asset_mismatch')
  }
  return checkAmount(accept.amount, manifestAmount, policy?.maxAmount)
}

/**
 * Keep only the x402 accepts entries that pass {@link checkX402Accept}. The
 * caller throws the rejection for `accepts[0]` when this returns empty.
 */
export function filterX402Accepts(
  accepts: readonly PaymentRequirements[],
  manifest: RouteDockManifest,
  network: Caip2Network,
  manifestAmount: string,
  policy?: ChallengePolicyOptions,
): PaymentRequirements[] {
  return accepts.filter((accept) => checkX402Accept(accept, manifest, network, manifestAmount, policy) === null)
}

/**
 * Validate an mpp-charge challenge request against the manifest.
 *
 * `@stellar/mpp` treats a missing `methodDetails.network` as `stellar:testnet`,
 * so this mirrors that default rather than rejecting an absent network.
 * Returns the rejection to throw, or `null` when the challenge is safe to sign.
 */
export function checkChargeChallenge(
  request: Record<string, unknown>,
  manifest: RouteDockManifest,
  network: Caip2Network,
  manifestAmount: string,
  policy?: ChallengePolicyOptions,
): RouteDockPolicyRejectError | null {
  const methodDetails = request['methodDetails']
  const rawNetwork = isRecord(methodDetails) ? methodDetails['network'] : undefined
  const challengeNetwork = rawNetwork === undefined ? 'stellar:testnet' : rawNetwork
  if (challengeNetwork !== network) {
    return new RouteDockPolicyRejectError('challenge_network_mismatch')
  }

  const recipient = request['recipient']
  if (typeof recipient !== 'string' || recipient !== resolvePayee(manifest, 'mpp-charge')) {
    return new RouteDockPolicyRejectError('challenge_payee_mismatch')
  }

  const currency = request['currency']
  if (typeof currency !== 'string' || currency !== manifest.asset_contract) {
    return new RouteDockPolicyRejectError('challenge_asset_mismatch')
  }

  return checkAmount(request['amount'], manifestAmount, policy?.maxAmount)
}
