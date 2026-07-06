import type { Request, Response, NextFunction, RequestHandler } from 'express'
import type { PaymentMode } from '../types.js'

/**
 * Provider settlement callbacks under test. Same shape as the real
 * `RouteDockMiddlewareOptions` callbacks, but accept sync or async fns so a
 * plain test spy works without wrapping it in a Promise.
 */
export interface MockRoutedockCallbacks {
  /** Called after each (synthetic) on-chain settlement. */
  onSettled?: (txHash: string, amount: string, mode: string) => void | Promise<void>
  /** Called once when a synthetic mpp-session is opened (first voucher). */
  onSessionOpen?: (channelId: string) => void | Promise<void>
  /** Called for each synthetic voucher in an mpp-session (1-based index). */
  onVoucher?: (voucherIndex: number, cumulativeAmount: string) => void | Promise<void>
}

/** Synthetic settlement values handed to the callbacks. All optional — sensible defaults per mode. */
export interface SyntheticPayment {
  /** On-chain tx hash passed to onSettled. Default: a fixed 64-hex string. */
  txHash?: string
  /** Settled amount (x402 / mpp-charge) passed to onSettled. Default: '0.001'. */
  amount?: string
  /** Channel address (mpp-session) passed to onSessionOpen. Default: a fixed C... address. */
  channelId?: string
  /** Per-voucher rate (mpp-session), in decimal string. Default: '0.0001'. */
  rate?: string
  /** Number of vouchers to emit before close (mpp-session). Default: 3. */
  voucherCount?: number
}

export interface MockRoutedockOptions extends MockRoutedockCallbacks {
  /** Payment mode the synthetic payment uses. Default: 'x402'. */
  mode?: PaymentMode
  /**
   * 'auto-pass' (default): synthesize a successful settlement, invoke the
   * configured callbacks with synthetic data, then call the route handler.
   * 'auto-fail': respond with `failStatus` and skip both callbacks and handler.
   */
  payment?: 'auto-pass' | 'auto-fail'
  /** Override the synthetic data handed to callbacks. */
  synthetic?: SyntheticPayment
  /** HTTP status used on 'auto-fail'. Default: 402. */
  failStatus?: number
}

/** Synthetic settlement record attached to `req.routedock` for assertions. */
export interface MockSettlementRecord {
  mode: PaymentMode
  txHash: string
  amount: string
  channelId?: string
  vouchers?: Array<{ index: number; cumulativeAmount: string }>
}

const DEFAULT_TX_HASH = '0000000000000000000000000000000000000000000000000000000000000000'
const DEFAULT_CHANNEL_ID = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'

/** Format a scaled (×1e7) BigInt as a 7-decimal string — mirrors the real handler. */
function format7(scaled: bigint): string {
  return (Number(scaled) / 1e7).toFixed(7)
}

/** Parse a decimal string into a ×1e7-scaled BigInt. */
function toScaled(decimal: string): bigint {
  const [whole, frac = ''] = decimal.split('.')
  const fracPadded = (frac + '0000000').slice(0, 7)
  return BigInt(whole + fracPadded)
}

/**
 * Drive a provider's settlement callbacks with synthetic data, with no Express
 * request involved. Useful for unit-testing an `onSettled` (e.g. a Supabase
 * write) in complete isolation. Returns the synthetic settlement record.
 *
 * Honors `payment: 'auto-fail'` by invoking no callbacks and returning null.
 */
export async function runMockSettlement(
  opts: MockRoutedockOptions,
): Promise<MockSettlementRecord | null> {
  const mode = opts.mode ?? 'x402'
  if ((opts.payment ?? 'auto-pass') === 'auto-fail') return null

  const s = opts.synthetic ?? {}
  const txHash = s.txHash ?? DEFAULT_TX_HASH

  if (mode === 'mpp-session') {
    const channelId = s.channelId ?? DEFAULT_CHANNEL_ID
    const rate = toScaled(s.rate ?? '0.0001')
    const count = s.voucherCount ?? 3

    if (opts.onSessionOpen) await opts.onSessionOpen(channelId)

    const vouchers: Array<{ index: number; cumulativeAmount: string }> = []
    for (let i = 1; i <= count; i++) {
      const cumulativeAmount = format7(rate * BigInt(i))
      vouchers.push({ index: i, cumulativeAmount })
      if (opts.onVoucher) await opts.onVoucher(i, cumulativeAmount)
    }

    const totalPaid = format7(rate * BigInt(count))
    if (opts.onSettled) await opts.onSettled(txHash, totalPaid, 'mpp-session')

    return { mode, txHash, amount: totalPaid, channelId, vouchers }
  }

  // x402 / mpp-charge: a single settlement.
  const amount = s.amount ?? '0.001'
  if (opts.onSettled) await opts.onSettled(txHash, amount, mode)
  return { mode, txHash, amount }
}

/**
 * Express middleware that mocks RouteDock payment verification — the testing
 * counterpart to `routedock()`. Drop it in front of a route to drive that
 * route's settlement callbacks with synthetic data, without any on-chain
 * settlement, facilitator, or wallet. Think `msw` for RouteDock providers.
 *
 * On `payment: 'auto-pass'` (default) it invokes the configured callbacks with
 * synthetic data and then calls the next handler (your route). On
 * `payment: 'auto-fail'` it responds with `failStatus` (402 by default) and
 * skips both the callbacks and the route handler — exactly as a real payment
 * rejection would.
 *
 * The synthetic settlement is attached to `req.routedock` for assertions.
 *
 * @example
 * ```ts
 * import express from 'express'
 * import request from 'supertest'
 * import { createMockRoutedockMiddleware } from '@routedock/routedock/testing'
 *
 * const onSettled = vi.fn()
 * const app = express()
 * app.use('/price', createMockRoutedockMiddleware({ mode: 'x402', payment: 'auto-pass', onSettled }))
 * app.get('/price', (_req, res) => res.json({ price: '42' }))
 *
 * await request(app).get('/price').expect(200)
 * expect(onSettled).toHaveBeenCalledWith(expect.any(String), '0.001', 'x402')
 * ```
 */
export function createMockRoutedockMiddleware(opts: MockRoutedockOptions = {}): RequestHandler {
  const payment = opts.payment ?? 'auto-pass'
  const failStatus = opts.failStatus ?? 402

  return (req: Request, res: Response, next: NextFunction): void => {
    if (payment === 'auto-fail') {
      res.status(failStatus).json({
        error: 'payment required',
        detail: 'mock routedock middleware: payment=auto-fail',
      })
      return
    }

    void runMockSettlement(opts)
      .then((record) => {
        if (record) (req as Request & { routedock?: MockSettlementRecord }).routedock = record
        next()
      })
      .catch((err) => next(err))
  }
}
