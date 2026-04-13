import { Keypair } from '@stellar/stellar-sdk'
import { stellar } from '@stellar/mpp/charge/client'
import { Mppx } from 'mppx/client'
import type { RouteDockManifest, PaymentResult } from '../types.js'
import { RouteDockManifestError } from '../types.js'

export class MppChargeClient {
  constructor(
    private readonly keypair: Keypair,
    private readonly network: 'testnet' | 'mainnet',
  ) {}

  async pay(url: string, manifest: RouteDockManifest): Promise<PaymentResult> {
    const pricing = manifest.pricing['mpp-charge']
    if (!pricing) {
      throw new RouteDockManifestError('manifest.pricing.mpp-charge missing')
    }

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

    const response = await mppx.fetch(url)
    if (!response.ok) {
      throw new RouteDockManifestError(`MPP charge failed: HTTP ${response.status}`)
    }

    const data = await response.json()
    return { data, txHash, mode: 'mpp-charge', amount: pricing.amount, timestamp: Date.now() }
  }
}
