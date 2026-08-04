import { Keypair } from '@stellar/stellar-sdk'
import { stellar } from '@stellar/mpp/charge/client'
import { Mppx } from 'mppx/client'
import type { RouteDockManifest, PaymentResult } from '../types.js'
import {
  RouteDockManifestError,
  httpStatusToError,
  wrapFetchError,
} from '../errors.js'
import { withRetry, type RetryPolicy } from '../internal/retry.js'

export class MppChargeClient {
  constructor(
    private readonly keypair: Keypair,
    private readonly network: 'testnet' | 'mainnet',
    private readonly retryPolicy?: RetryPolicy,
  ) {}

  async pay(url: string, manifest: RouteDockManifest): Promise<PaymentResult> {
    const pricing = manifest.pricing['mpp-charge']
    if (!pricing) {
      throw new RouteDockManifestError('manifest.pricing.mpp-charge missing')
    }

    return withRetry(async () => {
      let txHash: string | null = null

      const mppx = Mppx.create({
        polyfill: false,
        methods: [
          stellar.charge({
            keypair: this.keypair,
            mode: 'pull',
            onProgress(event) {
              if (event.type === 'paid') {
                txHash = event.hash
              }
            },
          }),
        ],
      })

      let response: Response
      try {
        response = await mppx.fetch(url)
      } catch (err) {
        throw wrapFetchError(err, 'MPP charge request')
      }

      if (!response.ok) {
        if (response.status >= 500 || response.status === 429 || response.status === 503) {
          throw httpStatusToError(
            `MPP charge failed: HTTP ${response.status}`,
            response.status,
            response,
          )
        }
        throw new RouteDockManifestError(`MPP charge failed: HTTP ${response.status}`)
      }

      const data = await response.json()
      return { data, txHash, mode: 'mpp-charge', amount: pricing.amount, timestamp: Date.now() }
    }, this.retryPolicy)
  }
}
