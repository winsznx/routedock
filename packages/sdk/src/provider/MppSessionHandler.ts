import type { Request, Response, NextFunction, RequestHandler } from 'express'
import { Keypair } from '@stellar/stellar-sdk'
import { stellar, close as channelClose, Store } from '@stellar/mpp/channel/server'
import { Mppx, Request as MppxRequest } from 'mppx/server'
import type { RouteDockManifest } from '../types.js'

type Network = 'testnet' | 'mainnet'

const MPP_NETWORK: Record<Network, 'stellar:testnet' | 'stellar:pubnet'> = {
  testnet: 'stellar:testnet',
  mainnet: 'stellar:pubnet',
}

export interface MppSessionHandlerOptions {
  payeeSecretKey: string
  network: Network
  channelContract: string
  rate: string
  assetContract: string
  manifest: RouteDockManifest
  commitmentPublicKey: string
  onSettled?: (txHash: string, totalPaid: string, mode: string) => Promise<void>
}

export function createMppSessionHandler(opts: MppSessionHandlerOptions): RequestHandler {
  const networkId = MPP_NETWORK[opts.network]
  const rateHuman = opts.rate
  const payeeKeypair = Keypair.fromSecret(opts.payeeSecretKey)
  const cumulativeKey = `stellar:channel:cumulative:${opts.channelContract}`

  const innerStore = Store.memory()

  // Wrap the store to intercept cumulative amount writes
  let lastCumulativeAmount = 0n
  const wrappedStore: ReturnType<typeof Store.memory> = {
    async get(key: string) { return innerStore.get(key) },
    async put(key: string, value: unknown) {
      await innerStore.put(key, value)
      if (key === cumulativeKey && value && typeof value === 'object' && 'amount' in (value as Record<string, unknown>)) {
        lastCumulativeAmount = BigInt((value as { amount: string }).amount)
      }
    },
    async delete(key: string) { return innerStore.delete(key) },
  }

  const mppx = Mppx.create({
    secretKey: opts.payeeSecretKey,
    methods: [
      stellar.channel({
        channel: opts.channelContract,
        commitmentKey: opts.commitmentPublicKey,
        network: networkId,
        store: wrappedStore,
        sourceAccount: payeeKeypair.publicKey(),
        feePayer: { envelopeSigner: payeeKeypair },
      }),
    ],
  })

  // Track the last signature from the authorization header
  let lastSignatureHex = ''

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (req.method === 'DELETE') {
        const body = req.body as { amount?: string; signature?: string } | undefined
        const closeAmount = body?.amount ? BigInt(body.amount) : lastCumulativeAmount
        const closeSig = body?.signature ?? lastSignatureHex

        if (closeAmount > 0n && closeSig) {
          const closeTxHash = await channelClose({
            channel: opts.channelContract,
            amount: closeAmount,
            signature: Buffer.from(closeSig, 'hex'),
            feePayer: { envelopeSigner: payeeKeypair },
            network: networkId,
          })

          if (opts.onSettled) {
            const totalPaid = (Number(lastCumulativeAmount) / 1e7).toFixed(7)
            await opts.onSettled(closeTxHash, totalPaid, 'mpp-session')
          }

          res.json({ closeTxHash })
        } else {
          res.json({ closeTxHash: null, message: 'no vouchers received' })
        }
        return
      }

      // Extract the signature from the authorization header before passing to mppx
      const authHeader = req.headers['authorization']
      if (typeof authHeader === 'string' && authHeader.startsWith('Payment ')) {
        try {
          const credB64 = authHeader.replace(/^Payment\s+/, '').split(',').find(p => p.trim().startsWith('credential='))
          if (credB64) {
            const credJson = Buffer.from(credB64.split('=').slice(1).join('=').replace(/^"|"$/g, ''), 'base64').toString('utf8')
            const cred = JSON.parse(credJson) as { payload?: { signature?: string } }
            if (cred.payload?.signature) {
              lastSignatureHex = cred.payload.signature
            }
          }
        } catch {
          // non-fatal — signature extraction is best-effort
        }
      }

      const fetchReq = MppxRequest.fromNodeListener(req, res)

      const result = await (mppx as unknown as {
        channel: (o: { amount: string; description?: string }) =>
          (r: globalThis.Request) => Promise<{
            status: number
            challenge?: globalThis.Response
            withReceipt?: (r: globalThis.Response) => globalThis.Response
          }>
      }).channel({
        amount: rateHuman,
        description: opts.manifest.name,
      })(fetchReq)

      if (result.status === 402) {
        const challenge = result.challenge!
        res.status(402)
        challenge.headers.forEach((v: string, k: string) => res.setHeader(k, v))
        const body = await challenge.text()
        res.send(body)
        return
      }

      next()
    } catch (err) {
      next(err)
    }
  }
}
