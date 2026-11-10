import type { Keypair } from '@stellar/stellar-sdk'
import { Errors, type Method } from 'mppx'

/**
 * The Stellar MPP SDK calls this field `feePayer`, but `envelopeSigner` is the
 * transaction source and contract authorizer. RouteDock only performs the
 * recipient-authorized `close()` path, so the provider payee key is required.
 */
export function channelAuthorizer(envelopeSigner: Keypair): { envelopeSigner: Keypair } {
  return { envelopeSigner }
}

export function formatMppError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    const serialized = JSON.stringify(error)
    return serialized === undefined ? String(error) : serialized
  } catch {
    return String(error)
  }
}

export function withTypedChannelErrors(method: Method.AnyServer): Method.AnyServer {
  return {
    ...method,
    async verify(parameters: Parameters<Method.AnyServer['verify']>[0]) {
      try {
        return await method.verify(parameters)
      } catch (error) {
        throw mapChannelError(error)
      }
    },
  } as Method.AnyServer
}

/** The shape `commit` needs from a channel credential — amount, signature, payer, and optional channel. */
export interface ChannelVerifyCredential {
  challenge?: {
    request?: {
      channel?: unknown
      [key: string]: unknown
    }
    [key: string]: unknown
  }
  payload?: { amount?: unknown; signature?: unknown; channel?: unknown }
  source?: string
  channel?: unknown
}

/**
 * Resolve the channel contract address named by a verified credential,
 * falling back to `defaultChannel` when none is specified on the credential.
 */
export function resolveCredentialChannel(
  credential: ChannelVerifyCredential | undefined | null,
  defaultChannel: string,
): string {
  const fromChallenge = credential?.challenge?.request?.channel
  if (typeof fromChallenge === 'string' && fromChallenge.length > 0) {
    return fromChallenge
  }
  const fromPayload = credential?.payload?.channel
  if (typeof fromPayload === 'string' && fromPayload.length > 0) {
    return fromPayload
  }
  const fromTop = credential?.channel
  if (typeof fromTop === 'string' && fromTop.length > 0) {
    return fromTop
  }
  return defaultChannel
}

/**
 * Wraps a channel method so `commit` only runs once the underlying `verify`
 * has resolved successfully. Nothing about a credential — its signature, its
 * amount, the payer it names — may be trusted or recorded before mppx has
 * actually verified it: a crafted header that fails verification must not be
 * able to overwrite state a previous, genuinely verified voucher set.
 *
 * If `verify` throws, `commit` is never called and the error propagates
 * unchanged (compose with {@link withTypedChannelErrors} for typed errors).
 */
export function onVerifiedCredential(
  method: Method.AnyServer,
  commit: (credential: ChannelVerifyCredential) => void | Promise<void>,
): Method.AnyServer {
  return {
    ...method,
    async verify(parameters: { credential: ChannelVerifyCredential; request: unknown }) {
      const receipt = await method.verify(parameters)
      await commit(parameters.credential)
      return receipt
    },
  } as Method.AnyServer
}

function mapChannelError(error: unknown): Error {
  const message = formatMppError(error)
  const details = error && typeof error === 'object' && 'details' in error
    ? (error as { details?: Record<string, unknown> }).details
    : undefined
  const reason = details && Object.keys(details).length > 0
    ? `${message} (${JSON.stringify(details)})`
    : message

  if (/signer mismatch|authori[sz]er|unauthori[sz]ed/i.test(message)) {
    return new Errors.SignerMismatchError({ reason })
  }
  if (/already used|replay|challenge/i.test(message)) {
    return new Errors.InvalidChallengeError({ reason })
  }
  if (/channel has been closed|channel is closed|finalized/i.test(message)) {
    return new Errors.ChannelClosedError({ reason })
  }
  if (/exceeds channel balance|exceeds.*deposit/i.test(message)) {
    return new Errors.AmountExceedsDepositError({ reason })
  }
  if (/channel not found|no channel/i.test(message)) {
    return new Errors.ChannelNotFoundError({ reason })
  }
  if (/must be greater|does not cover|below.*minimum/i.test(message)) {
    return new Errors.DeltaTooSmallError({ reason })
  }
  if (/signature/i.test(message)) {
    return new Errors.InvalidSignatureError({ reason })
  }
  return new Errors.VerificationFailedError({ reason })
}
