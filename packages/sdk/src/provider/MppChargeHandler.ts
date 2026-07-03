import type { Request, Response, NextFunction, RequestHandler } from 'express'
import { stellar } from '@stellar/mpp/charge/server'
import { Mppx, Request as MppxRequest } from 'mppx/server'
import type { RouteDockManifest } from '../types.js'
import type { SessionStore } from '../store/SessionStore.js'

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
  onSettled?: (txHash: string, amount: string, mode: string, payer: string | null) => Promise<void>
}

export function createMppChargeHandler(opts: MppChargeHandlerOptions): RequestHandler {
  const networkId = MPP_NETWORK[opts.network]
  const amountHumanReadable = opts.amount

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
            if (typeof key === 'string' && key.startsWith('G')) {
              payerAddress = key
            }
          }
        }
      } catch {
        // non-fatal — payer extraction is best-effort
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
      receipt.headers.forEach((v: string, k: string) => res.setHeader(k, v))

      // Extract tx hash from receipt headers if available
      const receiptHeader = receipt.headers.get('payment-receipt')
      if (receiptHeader && opts.onSettled) {
        try {
          const parsed = JSON.parse(
            Buffer.from(receiptHeader, 'base64').toString('utf8'),
          ) as { reference?: string }
          if (parsed.reference) {
            await opts.onSettled(parsed.reference, opts.amount, 'mpp-charge', payerAddress)
          }
        } catch {
          // non-fatal
        }
      }

      next()
    } catch (err) {
      next(err)
    }
  }
}
