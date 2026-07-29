import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import type { RequestHandler } from 'express'
import { createX402Handler } from './x402Handler.js'
import { createMppChargeHandler } from './MppChargeHandler.js'
import { createMppSessionHandler } from './MppSessionHandler.js'
import type { RouteDockManifest, PaymentMode } from '../types.js'

export interface RouteDockFastifyOptions {
  modes: PaymentMode[]
  pricing: {
    x402?: string
    'mpp-charge'?: string
    'mpp-session'?: { rate: string; channelFactory: string }
  }
  asset: string
  assetContract: string
  payee: string
  network: 'testnet' | 'mainnet'
  payeeSecretKey: string
  facilitatorApiKey?: string
  commitmentPublicKey?: string
  manifest: RouteDockManifest
  onSettled?: (txHash: string, amount: string, mode: string, payer: string | null) => Promise<void>
  onSessionOpen?: (channelId: string, payer: string | null) => Promise<void>
  onVoucher?: (voucherIndex: number, cumulativeAmount: string) => Promise<void>
}

function runExpressHandler(
  handler: RequestHandler,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  reply.hijack()

  const rawReq = request.raw as any
  if (typeof rawReq.get !== 'function') {
    const getHeader = (name: string): string | undefined => {
      const val = rawReq.headers[name.toLowerCase()]
      return Array.isArray(val) ? val.join(', ') : val
    }
    rawReq.get = rawReq.header = getHeader
  }
  if (!rawReq.protocol) {
    rawReq.protocol = request.protocol || 'http'
  }
  if (!rawReq.originalUrl) {
    rawReq.originalUrl = request.url
  }

  const rawRes = reply.raw as any
  if (typeof rawRes.status !== 'function') {
    rawRes.status = function (code: number) {
      rawRes.statusCode = code
      return rawRes
    }
  }
  if (typeof rawRes.set !== 'function') {
    rawRes.set = function (field: string | Record<string, string>, val?: string) {
      if (typeof field === 'object') {
        for (const [k, v] of Object.entries(field)) {
          rawRes.setHeader(k, v)
        }
      } else if (val !== undefined) {
        rawRes.setHeader(field, val)
      }
      return rawRes
    }
  }
  if (typeof rawRes.json !== 'function') {
    rawRes.json = function (data: unknown) {
      if (!rawRes.getHeader('content-type')) {
        rawRes.setHeader('Content-Type', 'application/json')
      }
      rawRes.end(JSON.stringify(data))
      return rawRes
    }
  }
  if (typeof rawRes.send !== 'function') {
    rawRes.send = function (body: unknown) {
      if (typeof body === 'object' && body !== null && !Buffer.isBuffer(body)) {
        return rawRes.json(body)
      }
      rawRes.end(body)
      return rawRes
    }
  }

  return new Promise<void>((resolve, reject) => {
    handler(
      rawReq,
      rawRes,
      (err?: unknown) => {
        if (err != null) reject(err)
        else resolve()
      },
    )
  })
}

export function routedockFastify(opts: RouteDockFastifyOptions): FastifyPluginAsync {
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
        throw new Error('routedockFastify: mpp-session mode requires commitmentPublicKey')
      }
      handlers.push(
        createMppSessionHandler({
          payeeSecretKey: opts.payeeSecretKey,
          network: opts.network,
          channelFactory: sessionPricing.channelFactory,
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

  const plugin: FastifyPluginAsync = async (fastify) => {
    fastify.addHook('onRequest', async (request, reply) => {
      if (request.url === '/.well-known/routedock.json') {
        reply.hijack()
        const body = JSON.stringify(opts.manifest)
        reply.raw.setHeader('Content-Type', 'application/json')
        reply.raw.end(body)
        return
      }

      if (handlers.length === 0) {
        return
      }

      const hasX402Header = !!(
        request.headers['payment-signature'] || request.headers['x-payment']
      )
      const prefersX402 = request.headers['x-preferred-mode'] === 'x402'

      const handler = hasX402Header || prefersX402
        ? handlers[0]
        : handlers[handlers.length - 1]

      if (!handler) {
        return
      }

      await runExpressHandler(handler, request, reply)
    })
  }

  return plugin
}
