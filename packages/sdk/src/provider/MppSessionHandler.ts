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
  onSettled?: (txHash: string, totalPaid: string, mode: string, payer: string | null) => Promise<void>
  onSessionOpen?: (channelId: string, payer: string | null) => Promise<void>
  onVoucher?: (voucherIndex: number, cumulativeAmount: string) => Promise<void>
  onCallbackError?: (err: unknown, cb: string) => void
}

export function createMppSessionHandler(opts: MppSessionHandlerOptions): RequestHandler {
  const networkId = MPP_NETWORK[opts.network]
  const rateHuman = opts.rate
  const payeeKeypair = Keypair.fromSecret(opts.payeeSecretKey)
  const cumulativeKey = `stellar:channel:cumulative:${opts.channelContract}`

  const innerStore = Store.memory()

  let lastCumulativeAmount = 0n
  let voucherCount = 0
  let sessionOpened = false
  // Payer address captured from the first Payment authorization header.
  // Persisted for onSessionOpen and onSettled calls.
  let sessionPayerAddress: string | null = null

  const wrappedStore: any = {
    async get(key: string) { return innerStore.get(key) },
    async put(key: string, value: unknown) {
      await innerStore.put(key, value)
      if (key === cumulativeKey && value && typeof value === 'object' && 'amount' in (value as Record<string, unknown>)) {
        lastCumulativeAmount = BigInt((value as { amount: string }).amount)
        voucherCount++
        if (!sessionOpened) {
          sessionOpened = true
          if (opts.onSessionOpen) {
            Promise.resolve().then(() => opts.onSessionOpen!(opts.channelContract, sessionPayerAddress)).catch(err => {
              console.error('[mpp-session] onSessionOpen callback error:', err)
              opts.onCallbackError?.(err, 'onSessionOpen')
            })
          }
        }
        if (opts.onVoucher) {
          const humanAmount = (Number(lastCumulativeAmount) / 1e7).toFixed(7)
          Promise.resolve().then(() => opts.onVoucher!(voucherCount, humanAmount)).catch(err => {
            console.error('[mpp-session] onVoucher callback error:', err)
            opts.onCallbackError?.(err, 'onVoucher')
          })
        }
      }
    },
    async delete(key: string) { return innerStore.delete(key) },
    update(key: any, fn: any) { return (innerStore as any).update(key, fn) },
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
            Promise.resolve().then(() => opts.onSettled!(closeTxHash, totalPaid, 'mpp-session', sessionPayerAddress)).catch(err => {
              console.error('[mpp-session] onSettled callback error:', err)
              opts.onCallbackError?.(err, 'onSettled')
            })
          }

          // Optionally record session_settled on the agent vault.
          // Requires AGENT_VAULT_CONTRACT and AGENT_VAULT_ADMIN_SECRET env vars.
          const vaultContract = process.env.AGENT_VAULT_CONTRACT
          const vaultAdminSecret = process.env.AGENT_VAULT_ADMIN_SECRET
          if (vaultContract && vaultAdminSecret) {
            try {
              const { Contract, TransactionBuilder, BASE_FEE, Networks, Account } = await import('@stellar/stellar-sdk')
              const { Server } = await import('@stellar/stellar-sdk/rpc')
              const adminKp = Keypair.fromSecret(vaultAdminSecret)
              const networkPassphrase = opts.network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET
              const rpcUrl = opts.network === 'mainnet'
                ? 'https://mainnet.sorobanrpc.com'
                : 'https://soroban-testnet.stellar.org'
              const server = new Server(rpcUrl)
              const sourceAccount = await server.getAccount(adminKp.publicKey())
              const vault = new Contract(vaultContract)
              const { nativeToScVal, Address: StellarAddress } = await import('@stellar/stellar-sdk')
              const op = vault.call(
                'record_session_settlement',
                nativeToScVal(opts.channelContract, { type: 'address' }),
                nativeToScVal(payeeKeypair.publicKey(), { type: 'address' }),
                nativeToScVal(payeeKeypair.publicKey(), { type: 'address' }),
                nativeToScVal(closeAmount, { type: 'i128' }),
                nativeToScVal(voucherCount, { type: 'u32' }),
              )
              const tx = new TransactionBuilder(sourceAccount, {
                fee: BASE_FEE,
                networkPassphrase,
              })
                .addOperation(op)
                .setTimeout(30)
                .build()
              const preparedTx = await server.prepareTransaction(tx)
              preparedTx.sign(adminKp)
              await server.sendTransaction(preparedTx)
            } catch (recordErr) {
              console.error('[mpp-session] failed to record session_settled on vault:', recordErr)
            }
          }

          res.json({ closeTxHash })
        } else {
          res.json({ closeTxHash: null, message: 'no vouchers received' })
        }

        sessionOpened = false
        voucherCount = 0
        lastCumulativeAmount = 0n
        sessionPayerAddress = null
        return
      }

      // Extract the signature (and payer address) from the authorization header before passing to mppx
      const authHeader = req.headers['authorization']
      if (typeof authHeader === 'string' && authHeader.startsWith('Payment ')) {
        try {
          const credB64 = authHeader.replace(/^Payment\s+/, '').split(',').find(p => p.trim().startsWith('credential='))
          if (credB64) {
            const credJson = Buffer.from(credB64.split('=').slice(1).join('=').replace(/^"|"$/g, ''), 'base64').toString('utf8')
            const cred = JSON.parse(credJson) as {
              sender?: string
              payload?: { signature?: string; sender?: string; from?: string }
            }
            if (cred.payload?.signature) {
              lastSignatureHex = cred.payload.signature
            }
            // Capture payer address on first voucher (before sessionOpened is set)
            if (!sessionPayerAddress) {
              const key = cred.sender ?? cred.payload?.sender ?? cred.payload?.from
              if (typeof key === 'string' && key.startsWith('G')) {
                sessionPayerAddress = key
              }
            }
          }
        } catch {
          // non-fatal — signature/payer extraction is best-effort
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

