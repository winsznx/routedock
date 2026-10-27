import { createEd25519Signer, type ClientStellarSigner } from '@x402/stellar'
import { ExactStellarScheme } from '@x402/stellar/exact/client'
import { x402Client, x402HTTPClient } from '@x402/core/client'
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
} from '@x402/core/http'
import type { RouteDockManifest, PaymentResult, PaymentRequest } from '../types.js'
import {
  RouteDockManifestError,
  RouteDockPolicyRejectError,
  RouteDockSignatureError,
  httpStatusToError,
  paymentRejectedError,
  wrapFetchError,
} from '../errors.js'
import { stroopsToUsdc } from '../internal/usdc.js'
import { readSettleResult } from '../internal/settleResult.js'
import { withRetry, type RetryPolicy } from '../internal/retry.js'
import { prepareRequest, toRequestInit } from '../internal/request.js'
import type { RouteDockLogger } from '../internal/logger.js'
import { checkX402Accept, filterX402Accepts, type Caip2Network } from './challenge.js'
import type { PaymentRequirements } from '@x402/core/types'

type Network = 'testnet' | 'mainnet'

const CAIP2: Record<Network, Caip2Network> = {
  testnet: 'stellar:testnet',
  mainnet: 'stellar:pubnet',
}

/** What an {@link X402PreSignHook} sees: the payment about to be signed. */
export interface X402PreSignContext {
  /** The resource being paid for. */
  readonly url: string
  /** The signed manifest the challenge was already bound to. */
  readonly manifest: RouteDockManifest
  /** The challenge entries that passed manifest binding — the signer picks from these. */
  readonly accepts: readonly PaymentRequirements[]
}

/** Verdict returned by an {@link X402PreSignHook}. */
export type X402PreSignDecision = { approve: true } | { approve: false; reason?: string }

/**
 * Optional guard run once per `pay()`, after the 402 challenge has been bound to
 * the manifest and immediately before anything is signed. Use it to plug in an
 * external or custom audit. Rejecting — or throwing — aborts before signing
 * (fail closed) with `RouteDockPolicyRejectError`.
 */
export type X402PreSignHook = (
  ctx: X402PreSignContext,
) => X402PreSignDecision | Promise<X402PreSignDecision>

/** Outcome of the retried unpaid probe. */
type ProbeOutcome =
  | { kind: 'free'; data: unknown }
  | { kind: 'payment-required'; init: Response }

export class X402Client {
  private readonly httpClient: x402HTTPClient
  private readonly signer: ClientStellarSigner
  private readonly logger: RouteDockLogger | undefined

  constructor(
    secretKeyOrSigner: string | ClientStellarSigner,
    private readonly network: Network,
    private readonly retryPolicy?: RetryPolicy,
    private readonly preSignHook?: X402PreSignHook,
    logger?: RouteDockLogger,
  ) {
    const caip2 = CAIP2[network]
    this.signer =
      typeof secretKeyOrSigner === 'string'
        ? createEd25519Signer(secretKeyOrSigner, caip2)
        : secretKeyOrSigner
    const scheme = new ExactStellarScheme(this.signer)
    const core = new x402Client()
    core.register(caip2, scheme)
    this.httpClient = new x402HTTPClient(core)
    this.logger = logger
  }

  /** Replace signer (e.g. swap to Nulth ZK account payer before pay) */
  withSigner(signer: ClientStellarSigner): X402Client {
    return new X402Client(signer, this.network, this.retryPolicy, this.preSignHook, this.logger)
  }

  async pay(
    url: string,
    manifest: RouteDockManifest,
    request?: PaymentRequest,
  ): Promise<PaymentResult> {
    const pricing = manifest.pricing.x402
    if (!pricing) {
      throw new RouteDockManifestError('manifest.pricing.x402 missing')
    }
    if (!pricing.facilitator) {
      throw new RouteDockManifestError('manifest.pricing.x402.facilitator missing')
    }

    const caip2 = CAIP2[this.network]

    // Buffer once, outside withRetry: the probe, the paid request and any
    // retry must all send the same method/headers/body.
    const prepared = await prepareRequest(request)

    // Phase 1: unpaid probe. This can retry freely — no payment exists yet.
    const probe = await withRetry(async (): Promise<ProbeOutcome> => {
      let init: Response
      try {
        init = await fetch(url, toRequestInit(prepared, { 'X-Preferred-Mode': 'x402' }))
      } catch (err) {
        throw wrapFetchError(err, 'x402 initial request')
      }

      this.logger?.('debug', '[x402] unpaid probe response', { status: init.status })

      if (init.status !== 402) {
        if (!init.ok) {
          throw httpStatusToError(
            `x402 initial request failed: HTTP ${init.status}`,
            init.status,
            init,
          )
        }
        let data: unknown
        try {
          data = await init.json()
        } catch {
          throw new RouteDockManifestError(
            `Failed to parse JSON from non-402 response (HTTP ${init.status})`,
          )
        }
        // A paywalled route answering the unpaid probe with 2xx makes this the
        // free path — nothing is paid, so txHash stays null and amount '0'.
        // #553: log it, because a silently-open paywall is otherwise invisible.
        this.logger?.(
          'debug',
          '[x402] unpaid probe returned non-402 success — serving as free response',
          { status: init.status },
        )
        return { kind: 'free', data }
      }

      return { kind: 'payment-required', init }
    }, this.retryPolicy)

    if (probe.kind === 'free') {
      return { data: probe.data, txHash: null, mode: 'x402', amount: '0', timestamp: Date.now() }
    }

    const init = probe.init
    const reqHeader = init.headers.get('X-Payment-Requirements')
    if (!reqHeader) {
      throw new RouteDockManifestError('402 response missing X-Payment-Requirements header')
    }

    let paymentRequired
    try {
      paymentRequired = decodePaymentRequiredHeader(reqHeader)
    } catch (err) {
      throw new RouteDockManifestError('402 X-Payment-Requirements header is malformed', {
        cause: err,
      })
    }

    const firstAccept = paymentRequired.accepts[0]
    if (!firstAccept) {
      throw new RouteDockManifestError('402 response carries no payment accepts')
    }

    // Phase 2: bind the unsigned 402 to the signed manifest BEFORE signing.
    // A mismatched challenge must never reach createPaymentPayload.
    const allowed = filterX402Accepts(paymentRequired.accepts, manifest, caip2, pricing.amount)
    if (allowed.length === 0) {
      // `accepts` is non-empty here, so accepts[0] — the entry the scheme would
      // have signed — failed its own checks. That rejection is the report.
      throw checkX402Accept(firstAccept, manifest, caip2, pricing.amount)
    }

    // Optional pre-sign audit. Runs once, before signing; never on retries.
    if (this.preSignHook) {
      let decision: X402PreSignDecision
      try {
        decision = await this.preSignHook({ url, manifest, accepts: allowed })
      } catch (err) {
        throw new RouteDockPolicyRejectError('pre_sign_hook_error', { cause: err })
      }
      if (!decision || decision.approve !== true) {
        const reason = decision && decision.approve === false ? decision.reason : undefined
        throw new RouteDockPolicyRejectError(reason ?? 'pre_sign_rejected')
      }
    }

    // Phase 3: sign exactly once per pay() call.
    let paymentPayload
    try {
      paymentPayload = await this.httpClient.createPaymentPayload({
        ...paymentRequired,
        accepts: allowed,
      })
    } catch (err) {
      throw new RouteDockSignatureError(`x402 payment signing failed: ${String(err)}`, {
        cause: err,
      })
    }

    const paymentHeaders = this.httpClient.encodePaymentSignatureHeader(paymentPayload)
    const signedAmount = stroopsToUsdc(BigInt(paymentPayload.accepted.amount))

    this.logger?.('debug', '[x402] sending paid request with payment header')

    // Phase 4: paid request. Retries reuse the SAME paymentHeaders object, so
    // the provider's idempotency store can replay the cached settlement rather
    // than charging a second time.
    const settled = await withRetry(async (): Promise<Response> => {
      let response: Response
      try {
        // Payment headers are layered last, so a caller cannot shadow them.
        response = await fetch(url, toRequestInit(prepared, paymentHeaders))
      } catch (err) {
        throw wrapFetchError(err, 'x402 settlement request')
      }

      this.logger?.('debug', '[x402] paid request response', { status: response.status })

      if (!response.ok) {
        if (response.status >= 500 || response.status === 429 || response.status === 503) {
          throw httpStatusToError(
            `x402 payment failed: HTTP ${response.status}`,
            response.status,
            response,
          )
        }
        throw await paymentRejectedError('x402 payment failed', response.status, response)
      }

      return response
    }, this.retryPolicy)

    // #553: read the response header with the provider's own settle-result
    // contract. `success: false`, or `success: true` carrying an empty
    // transaction, is not a settlement — txHash stays null rather than becoming
    // '', which is truthy enough to pass `assert(result.txHash)` checks and gets
    // stored or rendered downstream as if it were a transaction hash.
    let txHash: string | null = null
    const responseHeader = settled.headers.get('X-Payment-Response')
    if (!responseHeader) {
      this.logger?.('debug', '[x402] settled 2xx carried no X-Payment-Response header')
    } else {
      try {
        const outcome = readSettleResult(decodePaymentResponseHeader(responseHeader))
        if (outcome.ok) {
          txHash = outcome.txHash
        } else {
          this.logger?.('debug', '[x402] X-Payment-Response reports an unsettled payment', {
            ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
          })
        }
      } catch (err) {
        // non-fatal — some facilitators may omit the response header
        this.logger?.('debug', '[x402] X-Payment-Response header present but undecodable', {
          error: err,
        })
      }
    }

    let data: unknown
    try {
      data = await settled.json()
    } catch {
      throw new RouteDockManifestError('Failed to parse JSON from settled response')
    }
    return { data, txHash, mode: 'x402', amount: signedAmount, timestamp: Date.now() }
  }
}
