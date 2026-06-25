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
/** MPP modes, in the priority order used to pick the default (non-x402) handler. */
const MPP_MODES: readonly PaymentMode[] = ['mpp-session', 'mpp-charge']

export function routedock(opts: RouteDockMiddlewareOptions): RequestHandler {
  // Register each handler under its payment mode so routing is explicit and
  // never depends on insertion order.
  const handlerMap = new Map<PaymentMode, RequestHandler>()

  if (opts.modes.includes('x402')) {
    const x402Price = opts.pricing.x402
    if (x402Price) {
      handlerMap.set(
        'x402',
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
      handlerMap.set(
        'mpp-charge',
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
      handlerMap.set(
        'mpp-session',
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

  // The default (non-x402) handler is the highest-priority MPP mode that is
  // actually registered; if the provider speaks only x402, it defaults to that.
  const defaultMode: PaymentMode | undefined =
    MPP_MODES.find((mode) => handlerMap.has(mode)) ??
    (handlerMap.has('x402') ? 'x402' : undefined)

  return (req: Request, res: Response, next: NextFunction): void => {
    // Serve manifest at /.well-known/routedock.json
    if (req.path === '/.well-known/routedock.json') {
      res.json(opts.manifest)
      return
    }

    // No handlers — pass through
    if (handlerMap.size === 0) {
      next()
      return
    }

    // Route by mode, not array position.
    // x402 clients send `payment-signature` or `x-payment` headers (or opt in
    // via `x-preferred-mode: x402`). Those go to the x402 handler — and only
    // the x402 handler. Everything else (initial requests, mppx clients) goes
    // to the default MPP handler, which returns the WWW-Authenticate challenge.
    const hasX402Header = !!(req.headers['payment-signature'] || req.headers['x-payment'])
    const prefersX402 = req.headers['x-preferred-mode'] === 'x402'

    const x402Handler = handlerMap.get('x402')
    const defaultHandler = defaultMode ? handlerMap.get(defaultMode) : undefined

    // Prefer the x402 handler for x402 requests; if the provider doesn't offer
    // x402, fall back to the default handler rather than misrouting.
    const handler: RequestHandler | undefined =
      hasX402Header || prefersX402 ? (x402Handler ?? defaultHandler) : defaultHandler

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
