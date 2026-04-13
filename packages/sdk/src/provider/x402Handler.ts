import type { Request, Response, NextFunction, RequestHandler } from 'express'
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

export interface X402HandlerOptions {
  payeeSecretKey: string
  network: Network
  amount: string
  assetContract: string
  facilitatorApiKey?: string
  manifest: RouteDockManifest
  onSettled?: (txHash: string, amount: string, mode: string) => Promise<void>
}

export function createX402Handler(opts: X402HandlerOptions): RequestHandler {
  const caip2 = CAIP2[opts.network]
  const payeeKeypair = Keypair.fromSecret(opts.payeeSecretKey)
  const signer = createEd25519Signer(opts.payeeSecretKey, caip2)

  const useOzFacilitator = opts.network === 'mainnet' && opts.facilitatorApiKey

  // Mainnet: OZ hosted facilitator via x402ResourceServer
  // Testnet: local ExactStellarFacilitatorScheme (OZ facilitator does not serve testnet)
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

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const paymentHeader = (req.headers['payment-signature'] ?? req.headers['x-payment']) as string | undefined

      if (!paymentHeader) {
        if (ozServer) {
          const resourceInfo = {
            url: `${req.protocol}://${req.get('host') ?? ''}${req.originalUrl}`,
            description: opts.manifest.name,
          }
          const paymentRequired = await ozServer.createPaymentRequiredResponse(
            [requirements],
            resourceInfo,
          )
          res
            .status(402)
            .setHeader('Content-Type', 'application/json')
            .setHeader('X-Payment-Requirements', encodePaymentRequiredHeader(paymentRequired))
            .json({ error: 'Payment Required' })
        } else {
          const x402Response = {
            x402Version: 2,
            resource: {
              url: `${req.protocol}://${req.get('host') ?? ''}${req.originalUrl}`,
              description: opts.manifest.name,
            },
            accepts: [requirements],
          }
          res
            .status(402)
            .setHeader('Content-Type', 'application/json')
            .setHeader('X-Payment-Requirements', encodePaymentRequiredHeader(x402Response))
            .json({ error: 'Payment Required' })
        }
        return
      }

      const payload = decodePaymentSignatureHeader(paymentHeader)
      let txHash: string | null = null

      if (ozServer) {
        const settleResult = await ozServer.settlePayment(payload, requirements)
        txHash = (settleResult as { transaction?: string }).transaction ?? null
        if (settleResult) {
          res.setHeader(
            'X-Payment-Response',
            encodePaymentResponseHeader(
              settleResult as Parameters<typeof encodePaymentResponseHeader>[0],
            ),
          )
        }
      } else {
        const verifyResult = await localFacilitator.verify(
          payload as Parameters<typeof localFacilitator.verify>[0],
          requirements,
        )
        if (!verifyResult.isValid) {
          res.status(401).json({
            error: 'Payment verification failed',
            reason: (verifyResult as { invalidReason?: string }).invalidReason,
          })
          return
        }
        const settleResult = await localFacilitator.settle(
          payload as Parameters<typeof localFacilitator.settle>[0],
          requirements,
        )
        txHash = (settleResult as { transaction?: string }).transaction ?? null
        if (settleResult) {
          res.setHeader(
            'X-Payment-Response',
            encodePaymentResponseHeader(
              settleResult as Parameters<typeof encodePaymentResponseHeader>[0],
            ),
          )
        }
      }

      if (txHash && opts.onSettled) {
        await opts.onSettled(txHash, opts.amount, 'x402')
      }

      next()
    } catch (err) {
      console.error('[x402] Settlement error:', err)
      res.status(500).json({ error: 'Payment settlement failed' })
    }
  }
}
