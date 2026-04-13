import { createEd25519Signer } from '@x402/stellar'
import { ExactStellarScheme } from '@x402/stellar/exact/client'
import { x402Client, x402HTTPClient } from '@x402/core/client'
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from '@x402/core/http'
import type { Network as X402Network } from '@x402/core/types'
import type { RouteDockManifest, PaymentResult } from '../types.js'
import { RouteDockManifestError } from '../types.js'

type Network = 'testnet' | 'mainnet'

const CAIP2: Record<Network, X402Network> = {
  testnet: 'stellar:testnet',
  mainnet: 'stellar:pubnet',
}

export class X402Client {
  private readonly httpClient: x402HTTPClient

  constructor(
    private readonly secretKey: string,
    private readonly network: Network,
  ) {
    const caip2 = CAIP2[network]
    const signer = createEd25519Signer(secretKey, caip2)
    const scheme = new ExactStellarScheme(signer)
    const core = new x402Client()
    core.register(caip2, scheme)
    this.httpClient = new x402HTTPClient(core)
  }

  async pay(url: string, manifest: RouteDockManifest): Promise<PaymentResult> {
    const pricing = manifest.pricing.x402
    if (!pricing) {
      throw new RouteDockManifestError('manifest.pricing.x402 missing')
    }
    if (!pricing.facilitator) {
      throw new RouteDockManifestError('manifest.pricing.x402.facilitator missing')
    }

    // Initial request — expect 402. Include mode hint so middleware routes correctly.
    const init = await fetch(url, { headers: { 'X-Preferred-Mode': 'x402' } })
    if (init.status !== 402) {
      const data = await init.json()
      return { data, txHash: null, mode: 'x402', amount: pricing.amount, timestamp: Date.now() }
    }

    // Parse payment requirements from header
    const reqHeader = init.headers.get('X-Payment-Requirements')
    if (!reqHeader) {
      throw new RouteDockManifestError('402 response missing X-Payment-Requirements header')
    }

    const paymentRequired = decodePaymentRequiredHeader(reqHeader)

    // Build signed payment payload
    const paymentPayload = await this.httpClient.createPaymentPayload(paymentRequired)
    const paymentHeaders = this.httpClient.encodePaymentSignatureHeader(paymentPayload)

    // Re-request with payment
    const settled = await fetch(url, { headers: paymentHeaders })
    if (!settled.ok) {
      throw new RouteDockManifestError(`x402 payment failed: HTTP ${settled.status}`)
    }

    // Extract settlement tx hash from response header
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
  }
}
