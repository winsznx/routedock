import { Keypair } from '@stellar/stellar-sdk'
import { stellar } from '@stellar/mpp/charge/client'
import { Mppx } from 'mppx/client'
import type { RouteDockManifest, PaymentResult } from '../types.js'
import {
  RouteDockManifestError,
  RouteDockPolicyRejectError,
  httpStatusToError,
  wrapFetchError,
} from '../errors.js'
import { stroopsToUsdc } from '../internal/usdc.js'
import { withRetry, type RetryPolicy } from '../internal/retry.js'
import { checkChargeChallenge, type Caip2Network } from './challenge.js'

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

    const caip2: Caip2Network =
      this.network === 'mainnet' ? 'stellar:pubnet' : 'stellar:testnet'

    let txHash: string | null = null
    let signedAmount: string | undefined
    // The credential is created at most once per pay() call. Every retry after
    // the first reuses it, so the provider's idempotency store can replay the
    // cached settlement instead of charging a second time.
    let credential: string | undefined

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
      onChallenge: async (challenge, { createCredential }) => {
        // Bind the unsigned challenge to the signed manifest before signing.
        const request = challenge.request
        const rejection = checkChargeChallenge(request, manifest, caip2)
        if (rejection) throw rejection

        const amount = request['amount']
        if (typeof amount !== 'string') {
          throw new RouteDockPolicyRejectError('challenge_amount_invalid')
        }
        signedAmount = stroopsToUsdc(BigInt(amount))
        credential ??= await createCredential()
        return credential
      },
    })

    return withRetry(async (): Promise<PaymentResult> => {
      let response: Response
      try {
        response = credential
          ? await mppx.rawFetch(url, { headers: { Authorization: credential } })
          : await mppx.fetch(url)
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

      let data: unknown
      try {
        data = await response.json()
      } catch (cause) {
        throw new RouteDockManifestError(
          `Failed to parse JSON from response (HTTP ${response.status})`,
          { cause },
        )
      }
      return {
        data,
        txHash,
        mode: 'mpp-charge',
        amount: signedAmount ?? pricing.amount,
        timestamp: Date.now(),
      }
    }, this.retryPolicy)
  }
}
