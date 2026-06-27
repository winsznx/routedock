import type { Request, Response, NextFunction, RequestHandler } from 'express'
import { stellar } from '@stellar/mpp/charge/server'
import { Mppx, Request as MppxRequest } from 'mppx/server'
import type { RouteDockManifest } from '../types.js'
import type { SessionStore } from '../store/SessionStore.js'
import {
  InMemorySeenTxStore,
  paymentIdempotencyKey,
  type SeenTxStore,
} from './SeenTxStore.js'

type Network = 'testnet' | 'mainnet'

const MPP_NETWORK: Record<Network, 'stellar:testnet' | 'stellar:pubnet'> = {
  testnet: 'stellar:testnet',
  mainnet: 'stellar:pubnet',
}

export interface MppChargeHandlerOptions {
  payeeSecretKey: string
  network: Network
  amount: string
  assetContract: string
  manifest: RouteDockManifest
  store?: SessionStore
  onSettled?: (txHash: string, amount: string, mode: string) => Promise<void>
  /**
   * Idempotency store guarding against duplicate settlement when an agent
   * retries the same signed charge. Defaults to a per-handler in-memory store.
   */
  seenTxStore?: SeenTxStore
}

export function createMppChargeHandler(opts: MppChargeHandlerOptions): RequestHandler {
  const networkId = MPP_NETWORK[opts.network]
  const amountHumanReadable = opts.amount
  const seenTxStore = opts.seenTxStore ?? new InMemorySeenTxStore()

  const mppx = Mppx.create({
    secretKey: opts.payeeSecretKey,
    methods: [
      stellar.charge({
        recipient: opts.manifest.payee,
        currency: opts.assetContract,
        network: networkId,
        feePayer: { envelopeSigner: opts.payeeSecretKey },
      }),
    ],
  })

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Idempotency: a retry of an already-settled charge replays the cached
      // receipt headers instead of settling (and billing) a second time.
      const idempotencyKey = paymentIdempotencyKey((name) => {
        const v = req.headers[name.toLowerCase()]
        return Array.isArray(v) ? v[0] : (v as string | undefined)
      })
      if (idempotencyKey) {
        const cached = await seenTxStore.get(idempotencyKey)
        if (cached) {
          if (cached.headers) {
            for (const [k, val] of Object.entries(cached.headers)) {
              res.setHeader(k, val)
            }
          }
          next()
          return
        }
      }

      const fetchReq = MppxRequest.fromNodeListener(req, res)
      // `mppx['stellar/charge']` — method key is `name/intent`
      const handler = (
        mppx as unknown as {
          'stellar/charge': (
            opts: { amount: string; currency: string; recipient: string; description?: string },
          ) => (input: globalThis.Request) => Promise<{ status: 402 | 200; challenge?: globalThis.Response; withReceipt?: (r: globalThis.Response) => globalThis.Response }>
        }
      )['stellar/charge']
      const result = await handler({
        amount: amountHumanReadable,
        currency: opts.assetContract,
        recipient: opts.manifest.payee,
        description: opts.manifest.name,
      })(fetchReq)

      if (result.status === 402) {
        const challenge = result.challenge!
        res.status(402)
        challenge.headers.forEach((v: string, k: string) => res.setHeader(k, v))
        res.send(await challenge.text())
        return
      }

      // status 200 — payment verified
      const receipt = result.withReceipt!(new Response(''))
      const receiptHeaders: Record<string, string> = {}
      receipt.headers.forEach((v: string, k: string) => {
        res.setHeader(k, v)
        receiptHeaders[k] = v
      })

      // Extract tx hash from receipt headers if available
      const receiptHeader = receipt.headers.get('payment-receipt')
      let reference: string | undefined
      if (receiptHeader) {
        try {
          const parsed = JSON.parse(
            Buffer.from(receiptHeader, 'base64').toString('utf8'),
          ) as { reference?: string }
          reference = parsed.reference
        } catch {
          // non-fatal — receipt is opaque/unparseable
        }
      }

      // Record the settlement so a retry of this exact charge is deduped.
      if (idempotencyKey) {
        await seenTxStore.set(idempotencyKey, {
          txHash: reference ?? null,
          headers: receiptHeaders,
        })
      }

      if (reference && opts.onSettled) {
        await opts.onSettled(reference, opts.amount, 'mpp-charge')
      }

      next()
    } catch (err) {
      next(err)
    }
  }
}
