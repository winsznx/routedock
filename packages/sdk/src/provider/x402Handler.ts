import type { Request, Response, NextFunction, RequestHandler } from 'express'
import { createX402Core, type X402CoreOptions } from './x402Core.js'

export type X402HandlerOptions = X402CoreOptions

export function createX402Handler(opts: X402HandlerOptions): RequestHandler {
  const core = createX402Core(opts)

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const paymentHeader = (req.headers['payment-signature'] ?? req.headers['x-payment']) as string | undefined
    const resourceUrl = `${req.protocol}://${req.get('host') ?? ''}${req.originalUrl}`

    const outcome = await core.handle({ paymentHeader, resourceUrl })

    switch (outcome.kind) {
      case 'payment-required':
        res.status(outcome.status)
        for (const [key, value] of Object.entries(outcome.headers)) res.setHeader(key, value)
        res.json(outcome.body)
        return
      case 'verification-failed':
        res.status(outcome.status).json(outcome.body)
        return
      case 'error':
        res.status(outcome.status).json(outcome.body)
        return
      case 'settled':
        for (const [key, value] of Object.entries(outcome.headers)) res.setHeader(key, value)
        next()
        return
    }
  }
}
