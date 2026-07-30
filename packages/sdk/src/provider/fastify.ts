import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Request, Response, NextFunction, RequestHandler } from 'express'
import { createX402Handler } from './x402Handler.js'
import { createMppChargeHandler } from './MppChargeHandler.js'
import { createMppSessionHandler } from './MppSessionHandler.js'
import { signManifest } from '../manifest/sign.js'
import type { RouteDockManifest, PaymentMode } from '../types.js'
import type { SeenTxStore } from './SeenTxStore.js'
import type { OrphanedSessionInfo } from './MppSessionHandler.js'

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
  onCallbackError?: (err: unknown, cbName: string) => void
  onOrphaned?: (channelId: string, info: OrphanedSessionInfo) => Promise<void>
  idleTimeoutMs?: number
  seenTxStore?: SeenTxStore
}

// ---------------------------------------------------------------------------
// Express-compatible shim over Node's raw http objects
//
// Fastify's request.raw / reply.raw are plain Node IncomingMessage /
// ServerResponse. The Express-style handlers in this SDK call APIs that only
// exist on Express's extended versions (req.get, req.protocol, req.originalUrl,
// res.status, res.json, res.send, res.setHeader). This function builds a
// minimal shim so those calls work without modifying any handler.
// ---------------------------------------------------------------------------
function buildExpressShims(
  rawReq: IncomingMessage,
  rawRes: ServerResponse,
  fastifyRequest: FastifyRequest,
  fastifyReply: FastifyReply,
): { req: Request; res: Response } {
  // --- Request shim ---
  const req = rawReq as unknown as Request
  const urlStr = rawReq.url ?? '/'
  const parsedUrl = new URL(urlStr, 'http://placeholder')

  // Express-style header getter
  const reqGet = (name: string): string | undefined => {
    const val = rawReq.headers[name.toLowerCase()]
    return Array.isArray(val) ? val[0] : val
  }

  if (!('get' in req && typeof (req as any).get === 'function')) {
    Object.defineProperty(req, 'get', { value: reqGet, configurable: true })
    Object.defineProperty(req, 'header', { value: reqGet, configurable: true })
  }
  if (!('protocol' in req)) {
    Object.defineProperty(req, 'protocol', {
      get: () => (fastifyRequest.protocol ?? 'http'),
      configurable: true,
    })
  }
  if (!('originalUrl' in req)) {
    Object.defineProperty(req, 'originalUrl', { value: urlStr, configurable: true })
  }
  if (!('path' in req)) {
    Object.defineProperty(req, 'path', { value: parsedUrl.pathname, configurable: true })
  }
  if (!('query' in req)) {
    const q: Record<string, string> = {}
    parsedUrl.searchParams.forEach((v, k) => { q[k] = v })
    Object.defineProperty(req, 'query', { value: q, configurable: true })
  }

  // --- Response shim ---
  const res = rawRes as unknown as Response

  // Collect headers written via shim and flush at send time
  const extraHeaders: Record<string, string | string[]> = {}

  const resSend = (body?: unknown): Response => {
    if (!rawRes.headersSent) {
      for (const [k, v] of Object.entries(extraHeaders)) {
        rawRes.setHeader(k, v)
      }
      if (typeof body === 'string') {
        rawRes.end(body)
      } else if (body !== undefined && body !== null) {
        if (!rawRes.getHeader('content-type')) {
          rawRes.setHeader('Content-Type', 'application/json')
        }
        rawRes.end(JSON.stringify(body))
      } else {
        rawRes.end()
      }
    }
    return res
  }

  const resJson = (data: unknown): Response => {
    if (!rawRes.getHeader('content-type')) {
      rawRes.setHeader('Content-Type', 'application/json')
    }
    return resSend(data)
  }

  const resStatus = (code: number): Response => {
    rawRes.statusCode = code
    return res
  }

  const resSet = (field: string | Record<string, string | string[]>, val?: string | string[]): Response => {
    if (typeof field === 'object') {
      for (const [k, v] of Object.entries(field)) rawRes.setHeader(k, v)
    } else if (val !== undefined) {
      extraHeaders[field] = val
      rawRes.setHeader(field, val)
    }
    return res
  }

  const resSetHeader = (name: string, value: string | number | readonly string[]): Response => {
    rawRes.setHeader(name, value as string)
    return res
  }

  if (!('status' in res && typeof (res as any).status === 'function')) {
    Object.defineProperty(res, 'status', { value: resStatus, configurable: true })
    Object.defineProperty(res, 'json', { value: resJson, configurable: true })
    Object.defineProperty(res, 'send', { value: resSend, configurable: true })
    Object.defineProperty(res, 'set', { value: resSet, configurable: true })
    Object.defineProperty(res, 'setHeader', { value: resSetHeader, configurable: true })
    Object.defineProperty(res, 'end', {
      value: (data?: unknown) => { rawRes.end(data) },
      configurable: true,
    })
  }

  return { req, res }
}

/**
 * Run an Express-style handler against a Fastify request/reply pair.
 *
 * We hijack the reply so Fastify doesn't try to serialise the response a
 * second time — the shim writes directly to the underlying ServerResponse.
 */
function runExpressHandler(
  handler: RequestHandler,
  fastifyRequest: FastifyRequest,
  fastifyReply: FastifyReply,
): Promise<void> {
  fastifyReply.hijack()
  const { req, res } = buildExpressShims(
    fastifyRequest.raw,
    fastifyReply.raw,
    fastifyRequest,
    fastifyReply,
  )
  return new Promise<void>((resolve, reject) => {
    handler(req, res, (err?: unknown) => {
      if (err != null) reject(err)
      else resolve()
    })
  })
}

/** MPP modes in the priority order used to pick the default handler. */
const MPP_MODES: readonly PaymentMode[] = ['mpp-session', 'mpp-charge']

export function routedockFastify(opts: RouteDockFastifyOptions): FastifyPluginAsync {
  const signedManifest = signManifest(opts.manifest, opts.payeeSecretKey)
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
          manifest: signedManifest,
          ...(opts.onSettled ? { onSettled: opts.onSettled } : {}),
          ...(opts.onCallbackError ? { onCallbackError: opts.onCallbackError } : {}),
          ...(opts.seenTxStore ? { seenTxStore: opts.seenTxStore } : {}),
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
          manifest: signedManifest,
          ...(opts.onSettled ? { onSettled: opts.onSettled } : {}),
          ...(opts.onCallbackError ? { onCallbackError: opts.onCallbackError } : {}),
          ...(opts.seenTxStore ? { seenTxStore: opts.seenTxStore } : {}),
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
      handlerMap.set(
        'mpp-session',
        createMppSessionHandler({
          payeeSecretKey: opts.payeeSecretKey,
          network: opts.network,
          channelFactory: sessionPricing.channelFactory,
          rate: sessionPricing.rate,
          assetContract: opts.assetContract,
          manifest: signedManifest,
          commitmentPublicKey: opts.commitmentPublicKey,
          ...(opts.onSettled ? { onSettled: opts.onSettled } : {}),
          ...(opts.onSessionOpen ? { onSessionOpen: opts.onSessionOpen } : {}),
          ...(opts.onVoucher ? { onVoucher: opts.onVoucher } : {}),
          ...(opts.onCallbackError ? { onCallbackError: opts.onCallbackError } : {}),
          ...(opts.onOrphaned ? { onOrphaned: opts.onOrphaned } : {}),
          ...(opts.idleTimeoutMs != null ? { idleTimeoutMs: opts.idleTimeoutMs } : {}),
        }),
      )
    }
  }

  const defaultMode: PaymentMode | undefined =
    MPP_MODES.find((mode) => handlerMap.has(mode)) ??
    (handlerMap.has('x402') ? 'x402' : undefined)

  const plugin: FastifyPluginAsync = async (fastify) => {
    // Serve the signed manifest at the well-known endpoint
    fastify.addHook('onRequest', async (request, reply) => {
      if (request.url === '/.well-known/routedock.json') {
        reply.hijack()
        const body = JSON.stringify(signedManifest)
        reply.raw.setHeader('Content-Type', 'application/json')
        reply.raw.setHeader('Content-Length', Buffer.byteLength(body))
        reply.raw.end(body)
        return
      }

      if (handlerMap.size === 0) return

      // Route to the correct handler based on payment mode preference
      const prefersX402 =
        !!(request.headers['payment-signature'] || request.headers['x-payment']) ||
        request.headers['x-preferred-mode'] === 'x402'

      const selectedMode = prefersX402
        ? (handlerMap.has('x402') ? 'x402' : defaultMode)
        : defaultMode

      if (!selectedMode) return
      const handler = handlerMap.get(selectedMode)
      if (!handler) return

      await runExpressHandler(handler, request, reply)
    })
  }

  return plugin
}
