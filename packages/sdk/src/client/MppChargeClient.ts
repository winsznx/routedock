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

    let txHash: string | null = null
    // Signed at most once per pay(). onChallenge answers the 402 a single time
    // and caches the credential; retries resend it via rawFetch rather than
    // signing a fresh transfer, so the provider's idempotency store dedups it
    // and the auth-entry nonce blocks any on-chain replay. See #386.
    let credential: string | undefined

    const mppx = Mppx.create({
      polyfill: false,
      onChallenge: async (_challenge, { createCredential }) =>
        (credential ??= await createCredential()),
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

    return withRetry(async () => {
      let response: Response
      try {
        // First attempt: mppx.fetch answers the 402 challenge (signs once via
        // onChallenge). Later attempts resend the same credential with rawFetch.
        response =
          credential === undefined
            ? await mppx.fetch(url)
            : await mppx.rawFetch(url, { headers: { Authorization: credential } })
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
