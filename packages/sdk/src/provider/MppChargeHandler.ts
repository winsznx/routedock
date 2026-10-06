import type { Request, Response, NextFunction, RequestHandler } from 'express'
import { stellar } from '@stellar/mpp/charge/server'
import { Mppx, Request as MppxRequest } from 'mppx/server'
import type { RouteDockManifest } from '../types.js'
import { resolvePayee } from '../internal/payee.js'
import { extractPayerAddress } from './payer.js'
import type { SessionStore } from '../store/SessionStore.js'
import { resolveLogger, type RouteDockLogger } from '../internal/logger.js'
import {
  InMemorySeenTxStore,
  paymentIdempotencyKey,
  checkSettlementReplay,
  type SeenTxStore,
} from './SeenTxStore.js'
import { resolveAssetContract } from '../internal/assetUtils.js'

type Network = 'testnet' | 'mainnet'

const MPP_NETWORK: Record<Network, 'stellar:testnet' | 'stellar:pubnet'> = {
  testnet: 'stellar:testnet',
  mainnet: 'stellar:pubnet',
}

export interface MppChargeHandlerOptions {
  payeeSecretKey: string
  network: Network
  amount: string
  assetContract?: string
  manifest: RouteDockManifest
  /**
   * @deprecated Ignored. Charge mode opens no channel, so there is nothing for a session store to hold.
   */
  store?: SessionStore
  onSettled?: (txHash: string, amount: string, mode: string, payer: string | null) => Promise<void>
  onCallbackError?: (err: unknown, cb: string) => void
  /**
   * Idempotency store guarding against duplicate settlement when an agent
   * retries the same signed charge. Defaults to a per-handler in-memory store.
   */
  seenTxStore?: SeenTxStore
  /** Log sink for internal error paths. Defaults to a console-backed logger. */
  logger?: RouteDockLogger
}

export function createMppChargeHandler(opts: MppChargeHandlerOptions): RequestHandler {
  const networkId = MPP_NETWORK[opts.network]
  const amountHumanReadable = opts.amount
  const recipient = resolvePayee(opts.manifest, 'mpp-charge')
  const logger = resolveLogger(opts.logger)
  const seenTxStore = opts.seenTxStore ?? new InMemorySeenTxStore({ logger })

  const mppxInstances = new Map<string, unknown>()
  function getMppx(contract: string) {
    let instance = mppxInstances.get(contract)
    if (!instance) {
      instance = Mppx.create({
        secretKey: opts.payeeSecretKey,
        methods: [
          stellar.charge({
            recipient,
            currency: contract,
            network: networkId,
            feePayer: { envelopeSigner: opts.payeeSecretKey },
          }),
        ],
      })
      mppxInstances.set(contract, instance)
    }
    return instance
  }

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const endpoint = req.path || req.originalUrl
      const assetContract = resolveAssetContract(
        opts.manifest,
        'mpp-charge',
        endpoint,
        opts.assetContract,
      )
      const mppx = getMppx(assetContract)
      // Extract payer public key from the mppx Payment authorization header before
      // the mppx library consumes it. The Payment bearer credential JSON contains
      // a `sender` field with the payer's Stellar G... public key.
      let payerAddress: string | null = null
      try {
        const authHeader = req.headers['authorization']
        if (typeof authHeader === 'string' && authHeader.startsWith('Payment ')) {
          const credPart = authHeader
            .replace(/^Payment\s+/, '')
            .split(',')
            .find((p) => p.trim().startsWith('credential='))
          if (credPart) {
            const b64 = credPart.split('=').slice(1).join('=').replace(/^"|"$/g, '')
            const credJson = Buffer.from(b64, 'base64').toString('utf8')
            const cred = JSON.parse(credJson) as {
              sender?: string
              payload?: { sender?: string; from?: string }
            }
            const key = cred.sender ?? cred.payload?.sender ?? cred.payload?.from
            payerAddress = extractPayerAddress(key)
          }
        }
      } catch {
        // non-fatal — payer extraction is best-effort
      }

      // Idempotency: a retry of an already-settled charge replays the cached
      // receipt headers instead of settling (and billing) a second time. The
      // key is scoped to this route and replays are capped + time-bounded.
      const idempotencyKey = await paymentIdempotencyKey(
        (name) => {
          const v = req.headers[name.toLowerCase()]
          return Array.isArray(v) ? v[0] : (v as string | undefined)
        },
        {
          method: req.method,
          path: req.originalUrl.split('?')[0]!,
          amount: amountHumanReadable,
          payTo: recipient,
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
        currency: assetContract,
        recipient,
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
          createdAt: Date.now(),
        })
      }

      if (reference && opts.onSettled) {
        Promise.resolve().then(() => opts.onSettled!(reference!, opts.amount, 'mpp-charge', payerAddress)).catch(err => {
          logger('error', '[mpp-charge] onSettled callback error', { error: err })
          opts.onCallbackError?.(err, 'onSettled')
        })
      }

      next()
    } catch (err) {
      next(err)
    }
  }
}
