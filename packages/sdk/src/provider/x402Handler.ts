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
import { RouteDockManifestError } from '../errors.js'
import { resolvePayee } from '../internal/payee.js'
import { usdcToUnits } from '../internal/usdc.js'
import { extractPayerAddress } from './payer.js'
import { resolveAssetContract } from '../internal/assetUtils.js'
import { resolveLogger, type RouteDockLogger } from '../internal/logger.js'
import {
  InMemorySeenTxStore,
  paymentIdempotencyKey,
  checkSettlementReplay,
  type SeenTxStore,
} from './SeenTxStore.js'
import { readSettleResult } from './settleResult.js'

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
  assetContract?: string
  facilitatorApiKey?: string
  manifest: RouteDockManifest
  onSettled?: (txHash: string, amount: string, mode: string, payer: string | null) => Promise<void>
  onCallbackError?: (err: unknown, cb: string) => void
  /**
   * Idempotency store guarding against duplicate settlement when an agent
   * retries the same signed payment. Defaults to a per-handler in-memory store.
   */
  seenTxStore?: SeenTxStore
  /** Log sink for internal error paths. Defaults to a console-backed logger. */
  logger?: RouteDockLogger
}

export function createX402Handler(opts: X402HandlerOptions): RequestHandler {
  const caip2 = CAIP2[opts.network]
  const payeeKeypair = Keypair.fromSecret(opts.payeeSecretKey)
  const signer = createEd25519Signer(opts.payeeSecretKey, caip2)
  const logger = resolveLogger(opts.logger)
  const seenTxStore = opts.seenTxStore ?? new InMemorySeenTxStore({ logger })

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

  const amountInBaseUnits = String(usdcToUnits(opts.amount))
  const payTo = resolvePayee(opts.manifest, 'x402')

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const endpoint = req.path || req.originalUrl
      const assetContract = resolveAssetContract(
        opts.manifest,
        'x402',
        endpoint,
        opts.assetContract,
      )
      const requirements = {
        scheme: 'exact' as const,
        network: caip2,
        asset: assetContract,
        amount: amountInBaseUnits,
        payTo,
        maxTimeoutSeconds: 60,
        extra: {
          areFeesSponsored: true,
          ...(useOzFacilitator ? {} : { facilitatorAddresses: [payeeKeypair.publicKey()] }),
        },
      }

      // Shared unpaid/failed-settlement response: it always carries the same
      // payment requirements header an unpaid request would, so the agent can
      // retry, and never an X-Payment-Response header. It is defined here
      // because the requirements depend on the asset contract resolved for this
      // request's endpoint.
      const respondPaymentRequired = async (error: string, reason?: string): Promise<void> => {
        const body = { error, ...(reason ? { reason } : {}) }
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
            .json(body)
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
            .json(body)
        }
      }

      const paymentHeader = (req.headers['payment-signature'] ?? req.headers['x-payment']) as string | undefined

      if (!paymentHeader) {
        await respondPaymentRequired('Payment Required')
        return
      }

      // Idempotency: a retry of an already-settled payment replays the cached
      // settlement response instead of settling (and billing) a second time.
      // The key is scoped to this route so a payment settled elsewhere can
      // never replay here, and replays are capped + time-bounded.
      const idempotencyKey = await paymentIdempotencyKey(
        (name) => {
          const v = req.headers[name.toLowerCase()]
          return Array.isArray(v) ? v[0] : (v as string | undefined)
        },
        {
          method: req.method,
          path: req.originalUrl.split('?')[0]!,
          amount: requirements.amount,
          payTo: requirements.payTo,
        },
      )
      if (idempotencyKey) {
        const replayCheck = await checkSettlementReplay(seenTxStore, idempotencyKey)
        if (replayCheck.kind === 'spent') {
          res.status(402).json({ error: 'Payment already used' })
          return
        }
        if (replayCheck.kind === 'replay') {
          if (replayCheck.record.headers) {
            for (const [k, val] of Object.entries(replayCheck.record.headers)) {
              res.setHeader(k, val)
            }
          }
          next()
          return
        }
      }

      const payload = decodePaymentSignatureHeader(paymentHeader)
      let txHash: string | null = null
      // Extract payer public key defensively from the decoded x402 payload.
      // In the @x402/stellar ExactStellarScheme, the payer's G... address is at
      // payload.authorization.credentials[0].publicKey (StrKey-encoded G...).
      // Fall back to null if the path is absent — non-fatal for settlement.
      let payerAddress: string | null = null
      try {
        const creds = (
          payload as unknown as {
            authorization?: {
              credentials?: Array<{ publicKey?: string }>
            }
          }
        ).authorization?.credentials
        const key = Array.isArray(creds) ? creds[0]?.publicKey : undefined
        payerAddress = extractPayerAddress(key)
      } catch {
        // non-fatal
      }

      if (ozServer) {
        const settleResult = await ozServer.settlePayment(payload, requirements)
        const outcome = readSettleResult(settleResult)
        if (!outcome.ok) {
          await respondPaymentRequired('Payment settlement failed', outcome.reason)
          return
        }
        txHash = outcome.txHash
        res.setHeader(
          'X-Payment-Response',
          encodePaymentResponseHeader(
            settleResult as Parameters<typeof encodePaymentResponseHeader>[0],
          ),
        )
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
        const outcome = readSettleResult(settleResult)
        if (!outcome.ok) {
          await respondPaymentRequired('Payment settlement failed', outcome.reason)
          return
        }
        txHash = outcome.txHash
        res.setHeader(
          'X-Payment-Response',
          encodePaymentResponseHeader(
            settleResult as Parameters<typeof encodePaymentResponseHeader>[0],
          ),
        )
      }

      // Record the settlement so a retry of this exact payment is deduped.
      if (idempotencyKey) {
        const headers: Record<string, string> = {}
        const paymentResponse = res.getHeader('X-Payment-Response')
        if (typeof paymentResponse === 'string') {
          headers['X-Payment-Response'] = paymentResponse
        }
        await seenTxStore.set(idempotencyKey, { txHash, headers, createdAt: Date.now() })
      }

      if (txHash && opts.onSettled) {
        Promise.resolve().then(() => opts.onSettled!(txHash!, opts.amount, 'x402', payerAddress)).catch(err => {
          logger('error', '[x402] onSettled callback error', { error: err })
          opts.onCallbackError?.(err, 'onSettled')
        })
      }

      next()
    } catch (err) {
      if (err instanceof RouteDockManifestError) {
        next(err)
        return
      }
      logger('error', '[x402] Settlement error', { error: err })
      res.status(500).json({ error: 'Payment settlement failed' })
    }
  }
}
