import { createEd25519Signer, type ClientStellarSigner } from '@x402/stellar'
import { ExactStellarScheme } from '@x402/stellar/exact/client'
import { x402Client, x402HTTPClient } from '@x402/core/client'
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
} from '@x402/core/http'
import type { Network as X402Network } from '@x402/core/types'
import type { RouteDockManifest, PaymentResult } from '../types.js'
import {
  RouteDockManifestError,
  RouteDockSignatureError,
  httpStatusToError,
  wrapFetchError,
} from '../errors.js'
import { withRetry, type RetryPolicy } from '../internal/retry.js'

type Network = 'testnet' | 'mainnet'

const CAIP2: Record<Network, X402Network> = {
  testnet: 'stellar:testnet',
  mainnet: 'stellar:pubnet',
}

export class X402Client {
  private readonly httpClient: x402HTTPClient
  private readonly signer: ClientStellarSigner

  constructor(
    secretKeyOrSigner: string | ClientStellarSigner,
    private readonly network: Network,
    private readonly retryPolicy?: RetryPolicy,
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
  }

  /** Replace signer (e.g. swap to Covenant ZK account payer before pay) */
  withSigner(signer: ClientStellarSigner): X402Client {
    return new X402Client(signer, this.network, this.retryPolicy)
  }

  async pay(url: string, manifest: RouteDockManifest): Promise<PaymentResult> {
    const pricing = manifest.pricing.x402
    if (!pricing) {
      throw new RouteDockManifestError('manifest.pricing.x402 missing')
    }
    if (!pricing.facilitator) {
      throw new RouteDockManifestError('manifest.pricing.x402.facilitator missing')
    }

    return withRetry(async () => {
      // Initial request — expect 402. Include mode hint so middleware routes correctly.
      let init: Response
      try {
        init = await fetch(url, { headers: { 'X-Preferred-Mode': 'x402' } })
      } catch (err) {
        throw wrapFetchError(err, 'x402 initial request')
      }

      if (init.status !== 402) {
        const data = await init.json()
        return { data, txHash: null, mode: 'x402', amount: pricing.amount, timestamp: Date.now() }
      }

      const reqHeader = init.headers.get('X-Payment-Requirements')
      if (!reqHeader) {
        throw new RouteDockManifestError('402 response missing X-Payment-Requirements header')
      }

      const paymentRequired = decodePaymentRequiredHeader(reqHeader)

      let paymentPayload
      try {
        paymentPayload = await this.httpClient.createPaymentPayload(paymentRequired)
      } catch (err) {
        throw new RouteDockSignatureError(`x402 payment signing failed: ${String(err)}`, {
          cause: err,
        })
      }

      const paymentHeaders = this.httpClient.encodePaymentSignatureHeader(paymentPayload)

      let settled: Response
      try {
        settled = await fetch(url, { headers: paymentHeaders })
      } catch (err) {
        throw wrapFetchError(err, 'x402 settlement request')
      }

      if (!settled.ok) {
        if (settled.status >= 500 || settled.status === 429 || settled.status === 503) {
          throw httpStatusToError(
            `x402 payment failed: HTTP ${settled.status}`,
            settled.status,
            settled,
          )
        }
        throw new RouteDockManifestError(`x402 payment failed: HTTP ${settled.status}`)
      }

      let txHash: string | null = null
      const responseHeader = settled.headers.get('X-Payment-Response')
      if (responseHeader) {
        try {
          const settleResponse = decodePaymentResponseHeader(responseHeader)
          txHash = (settleResponse as { transaction?: string }).transaction ?? null
        } catch {
          // non-fatal — some facilitators may omit the response header
        }
      }

      const data = await settled.json()
      return { data, txHash, mode: 'x402', amount: pricing.amount, timestamp: Date.now() }
    }, this.retryPolicy)
  }
}
