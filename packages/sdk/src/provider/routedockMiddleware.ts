import type { Request, Response, NextFunction, RequestHandler } from 'express'
import { createX402Handler } from './x402Handler.js'
import { createMppChargeHandler } from './MppChargeHandler.js'
import { createMppSessionHandler } from './MppSessionHandler.js'
import type { RouteDockManifest, PaymentMode } from '../types.js'

export interface RouteDockMiddlewareOptions {
  modes: PaymentMode[]
  pricing: {
    x402?: string
    'mpp-charge'?: string
    'mpp-session'?: { rate: string; channelContract: string }
  }
  asset: string
  /** Stellar Asset Contract address for the payment asset */
  assetContract: string
  payee: string
  network: 'testnet' | 'mainnet'
  /** Private key (S...) of the server/payee account */
  payeeSecretKey: string
  /** Required for x402 mode */
  facilitatorApiKey?: string
  /** Required for mpp-session mode — ed25519 public key (G...) for verifying commitments */
  commitmentPublicKey?: string
  /** Full RouteDock manifest — served at /.well-known/routedock.json */
  manifest: RouteDockManifest
  /** Called after each successful on-chain settlement */
  onSettled?: (txHash: string, amount: string, mode: string) => Promise<void>
  /** Called when a new mpp-session is opened (first voucher received) */
  onSessionOpen?: (channelId: string) => Promise<void>
  /** Called after each verified voucher in an mpp-session */
  onVoucher?: (voucherIndex: number, cumulativeAmount: string) => Promise<void>
}

/**
 * Express middleware factory for RouteDock provider endpoints.
 *
 * Automatically serves /.well-known/routedock.json and enforces payment
 * verification for all three modes (x402, mpp-charge, mpp-session).
 *
 * @example
 * ```ts
 * import { routedock } from '@routedock/sdk/provider'
 *
 * app.use('/price', routedock({
 *   modes: ['x402', 'mpp-charge'],
 *   pricing: { x402: '0.001', 'mpp-charge': '0.0008' },
 *   ...
 * }))
 * ```
 */
export function routedock(opts: RouteDockMiddlewareOptions): RequestHandler {
  const handlers: RequestHandler[] = []

  if (opts.modes.includes('x402')) {
    const x402Price = opts.pricing.x402
    if (x402Price) {
      handlers.push(
        createX402Handler({
          payeeSecretKey: opts.payeeSecretKey,
          network: opts.network,
          amount: x402Price,
          assetContract: opts.assetContract,
          ...(opts.facilitatorApiKey ? { facilitatorApiKey: opts.facilitatorApiKey } : {}),
          manifest: opts.manifest,
          ...(opts.onSettled ? { onSettled: opts.onSettled } : {}),
        }),
      )
    }
  }

  if (opts.modes.includes('mpp-charge')) {
    const chargePrice = opts.pricing['mpp-charge']
    if (chargePrice) {
      handlers.push(
        createMppChargeHandler({
          payeeSecretKey: opts.payeeSecretKey,
          network: opts.network,
          amount: chargePrice,
          assetContract: opts.assetContract,
          manifest: opts.manifest,
          ...(opts.onSettled ? { onSettled: opts.onSettled } : {}),
        }),
      )
    }
  }

  if (opts.modes.includes('mpp-session')) {
    const sessionPricing = opts.pricing['mpp-session']
    if (sessionPricing) {
      if (!opts.commitmentPublicKey) {
        throw new Error('routedock: mpp-session mode requires commitmentPublicKey')
      }
      handlers.push(
        createMppSessionHandler({
          payeeSecretKey: opts.payeeSecretKey,
          network: opts.network,
          channelContract: sessionPricing.channelContract,
          rate: sessionPricing.rate,
          assetContract: opts.assetContract,
          manifest: opts.manifest,
          commitmentPublicKey: opts.commitmentPublicKey,
          ...(opts.onSettled ? { onSettled: opts.onSettled } : {}),
          ...(opts.onSessionOpen ? { onSessionOpen: opts.onSessionOpen } : {}),
          ...(opts.onVoucher ? { onVoucher: opts.onVoucher } : {}),
        }),
      )
    }
  }

  return (req: Request, res: Response, next: NextFunction): void => {
    // Serve manifest at /.well-known/routedock.json
    if (req.path === '/.well-known/routedock.json') {
      res.json(opts.manifest)
      return
    }

    // No handlers — pass through
    if (handlers.length === 0) {
      next()
      return
    }

    // Route to the correct handler based on request headers.
    // x402 clients send `payment-signature` or `x-payment` headers.
    // mppx clients send `authorization` with the mppx bearer scheme.
    // On initial request (no payment), use the last handler (mppx returns
    // WWW-Authenticate which x402 clients ignore; x402 only runs when its
    // header is explicitly present).
    const hasX402Header = !!(req.headers['payment-signature'] || req.headers['x-payment'])
    const prefersX402 = req.headers['x-preferred-mode'] === 'x402'

    let handler: RequestHandler | undefined
    if (hasX402Header || prefersX402) {
      handler = handlers[0]
    } else {
      handler = handlers[handlers.length - 1]
    }

    if (!handler) {
      next()
      return
    }
    void Promise.resolve()
      .then(() => new Promise<void>((resolve, reject) => {
        handler!(req, res, (handlerErr?: unknown) => {
          if (handlerErr != null) reject(handlerErr)
          else resolve()
        })
      }))
      .then(() => next())
      .catch((err) => next(err))
  }
}
