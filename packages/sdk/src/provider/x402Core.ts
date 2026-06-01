import { Keypair } from '@stellar/stellar-sdk'
import { ExactStellarScheme as ExactStellarFacilitatorScheme } from '@x402/stellar/exact/facilitator'
import { ExactStellarScheme as ExactStellarServerScheme } from '@x402/stellar/exact/server'
import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server'
import { createEd25519Signer } from '@x402/stellar'
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from '@x402/core/http'
import type { Network as X402Network } from '@x402/core/types'
import type { RouteDockManifest } from '../types.js'

type Network = 'testnet' | 'mainnet'

const CAIP2: Record<Network, X402Network> = {
  testnet: 'stellar:testnet',
  mainnet: 'stellar:pubnet',
}

const OZ_FACILITATOR_URL = 'https://channels.openzeppelin.com/x402'

export interface X402CoreOptions {
  payeeSecretKey: string
  network: Network
  amount: string
  assetContract: string
  facilitatorApiKey?: string
  manifest: RouteDockManifest
  onSettled?: (txHash: string, amount: string, mode: string) => Promise<void>
}

/**
 * Framework-agnostic outcome of running the x402 settlement flow against an
 * incoming request. The transport adapter (Express, Hono, …) translates this
 * into a concrete HTTP response.
 */
export type X402Outcome =
  /** No payment header — challenge the client with HTTP 402. */
  | { kind: 'payment-required'; status: 402; headers: Record<string, string>; body: unknown }
  /** Payment present but invalid — reject with HTTP 401. */
  | { kind: 'verification-failed'; status: 401; body: unknown }
  /** Payment settled — attach `headers` and serve the protected resource. */
  | { kind: 'settled'; headers: Record<string, string> }
  /** Unexpected failure during settlement — respond with HTTP 500. */
  | { kind: 'error'; status: 500; body: unknown }

export interface X402Core {
  handle(input: { paymentHeader: string | undefined; resourceUrl: string }): Promise<X402Outcome>
}

/**
 * Builds the runtime-agnostic x402 settlement engine shared by the Express
 * middleware and the Hono adapter. All Stellar/x402 protocol logic lives here;
 * the transport adapters only read the request header and write the response.
 */
export function createX402Core(opts: X402CoreOptions): X402Core {
  const caip2 = CAIP2[opts.network]
  const payeeKeypair = Keypair.fromSecret(opts.payeeSecretKey)
  const signer = createEd25519Signer(opts.payeeSecretKey, caip2)

  const useOzFacilitator = opts.network === 'mainnet' && opts.facilitatorApiKey

  const localFacilitator = new ExactStellarFacilitatorScheme([signer], {
    areFeesSponsored: true,
  })

  let ozServer: x402ResourceServer | null = null
  if (useOzFacilitator) {
    const apiKey = opts.facilitatorApiKey!
    const facilitator = new HTTPFacilitatorClient({
      url: OZ_FACILITATOR_URL,
      createAuthHeaders: async () => ({
        verify: { Authorization: `Bearer ${apiKey}` },
        settle: { Authorization: `Bearer ${apiKey}` },
        supported: { Authorization: `Bearer ${apiKey}` },
      }),
    })
    ozServer = new x402ResourceServer(facilitator)
    ozServer.register(caip2, new ExactStellarServerScheme())
  }

  const amountInBaseUnits = String(Math.round(parseFloat(opts.amount) * 1e7))
  const requirements = {
    scheme: 'exact' as const,
    network: caip2,
    asset: opts.assetContract,
    amount: amountInBaseUnits,
    payTo: opts.manifest.payee,
    maxTimeoutSeconds: 60,
    extra: {
      areFeesSponsored: true,
      ...(useOzFacilitator ? {} : { facilitatorAddresses: [payeeKeypair.publicKey()] }),
    },
  }

  async function handle(input: { paymentHeader: string | undefined; resourceUrl: string }): Promise<X402Outcome> {
    try {
      if (!input.paymentHeader) {
        const resource = { url: input.resourceUrl, description: opts.manifest.name }
        if (ozServer) {
          const paymentRequired = await ozServer.createPaymentRequiredResponse([requirements], resource)
          return {
            kind: 'payment-required',
            status: 402,
            headers: {
              'Content-Type': 'application/json',
              'X-Payment-Requirements': encodePaymentRequiredHeader(paymentRequired),
            },
            body: { error: 'Payment Required' },
          }
        }
        const x402Response = {
          x402Version: 2,
          resource,
          accepts: [requirements],
        }
        return {
          kind: 'payment-required',
          status: 402,
          headers: {
            'Content-Type': 'application/json',
            'X-Payment-Requirements': encodePaymentRequiredHeader(x402Response),
          },
          body: { error: 'Payment Required' },
        }
      }

      const payload = decodePaymentSignatureHeader(input.paymentHeader)
      const headers: Record<string, string> = {}
      let txHash: string | null = null

      if (ozServer) {
        const settleResult = await ozServer.settlePayment(payload, requirements)
        txHash = (settleResult as { transaction?: string }).transaction ?? null
        if (settleResult) {
          headers['X-Payment-Response'] = encodePaymentResponseHeader(
            settleResult as Parameters<typeof encodePaymentResponseHeader>[0],
          )
        }
      } else {
        const verifyResult = await localFacilitator.verify(
          payload as Parameters<typeof localFacilitator.verify>[0],
          requirements,
        )
        if (!verifyResult.isValid) {
          return {
            kind: 'verification-failed',
            status: 401,
            body: {
              error: 'Payment verification failed',
              reason: (verifyResult as { invalidReason?: string }).invalidReason,
            },
          }
        }
        const settleResult = await localFacilitator.settle(
          payload as Parameters<typeof localFacilitator.settle>[0],
          requirements,
        )
        txHash = (settleResult as { transaction?: string }).transaction ?? null
        if (settleResult) {
          headers['X-Payment-Response'] = encodePaymentResponseHeader(
            settleResult as Parameters<typeof encodePaymentResponseHeader>[0],
          )
        }
      }

      if (txHash && opts.onSettled) {
        await opts.onSettled(txHash, opts.amount, 'x402')
      }

      return { kind: 'settled', headers }
    } catch (err) {
      console.error('[x402] Settlement error:', err)
      return { kind: 'error', status: 500, body: { error: 'Payment settlement failed' } }
    }
  }

  return { handle }
}
