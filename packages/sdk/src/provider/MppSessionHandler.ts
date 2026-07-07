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

/** Why a live session was flagged as orphaned (never cleanly closed). */
export type OrphanReason = 'connection-closed' | 'idle-timeout'

/** Latest signed state of an orphaned session, enough for the reconciler to settle. */
export interface OrphanedSessionInfo {
  /** Cumulative amount of the highest voucher seen (human-readable, 7 dp). */
  cumulativeAmount: string
  /** Hex-encoded signature of the highest voucher seen. */
  lastSignature: string
  /** Number of vouchers received before teardown. */
  voucherCount: number
  /** What triggered the orphan flag. */
  reason: OrphanReason
}

export interface MppSessionHandlerOptions {
  payeeSecretKey: string
  network: Network
  channelFactory: string
  rate: string
  assetContract: string
  manifest: RouteDockManifest
  commitmentPublicKey: string
  onSettled?: (txHash: string, totalPaid: string, mode: string, payer: string | null) => Promise<void>
  onSessionOpen?: (channelId: string, payer: string | null) => Promise<void>
  onVoucher?: (voucherIndex: number, cumulativeAmount: string) => Promise<void>
  onCallbackError?: (err: unknown, cb: string) => void
  /**
   * Called when the client connection drops mid-session or the session goes
   * idle, before a clean close. Persist the session as `closing` so the
   * SessionReconciler can settle it with the latest signed voucher.
   */
  onOrphaned?: (channelId: string, info: OrphanedSessionInfo) => Promise<void>
  /**
   * Flag the session orphaned after this many milliseconds with no voucher
   * activity. Disabled when unset.
   */
  idleTimeoutMs?: number
}

export function createMppSessionHandler(opts: MppSessionHandlerOptions): RequestHandler {
  const networkId = MPP_NETWORK[opts.network]
  const rateHuman = opts.rate
  const payeeKeypair = Keypair.fromSecret(opts.payeeSecretKey)
  const cumulativeKey = `stellar:channel:cumulative:${opts.channelFactory}`

  const innerStore = Store.memory()

  let lastCumulativeAmount = 0n
  let voucherCount = 0
  let sessionOpened = false
  // Payer address captured from the first Payment authorization header.
  // Persisted for onSessionOpen and onSettled calls.
  let sessionPayerAddress: string | null = null
  // Track the last signature from the authorization header
  let lastSignatureHex = ''
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  // Set once a session is settled via DELETE so teardown handlers don't
  // re-flag an already-closed session as orphaned.
  let settledCleanly = false
  // Guards against registering more than one 'close' listener per session.
  let closeListenerArmed = false

  function clearIdleTimer(): void {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  function armIdleTimer(): void {
    if (!opts.idleTimeoutMs) return
    clearIdleTimer()
    idleTimer = setTimeout(() => {
      void flagOrphan('idle-timeout')
    }, opts.idleTimeoutMs)
    // Don't keep the process alive solely for this timer.
    if (typeof idleTimer.unref === 'function') idleTimer.unref()
  }

  // Flag an open-but-unsettled session for the reconciler. Idempotent: a
  // session that was cleanly settled or already flagged is left untouched.
  async function flagOrphan(reason: OrphanReason): Promise<void> {
    if (!sessionOpened || settledCleanly) return
    sessionOpened = false
    closeListenerArmed = false
    clearIdleTimer()

    const cumulativeAmount = (Number(lastCumulativeAmount) / 1e7).toFixed(7)
    if (opts.onOrphaned) {
      try {
        await opts.onOrphaned(opts.channelFactory, {
          cumulativeAmount,
          lastSignature: lastSignatureHex,
          voucherCount,
          reason,
        })
      } catch (err) {
        console.error('[mpp-session] onOrphaned handler failed:', err)
      }
    }
  }

  const wrappedStore: any = {
    async get(key: string) { return innerStore.get(key) },
    async put(key: string, value: unknown) {
      await innerStore.put(key, value)
      if (key === cumulativeKey && value && typeof value === 'object' && 'amount' in (value as Record<string, unknown>)) {
        lastCumulativeAmount = BigInt((value as { amount: string }).amount)
        voucherCount++
        // Voucher activity — this session is alive again.
        settledCleanly = false
        armIdleTimer()

        if (!sessionOpened) {
          sessionOpened = true
          if (opts.onSessionOpen) {
            Promise.resolve()
              .then(() => opts.onSessionOpen!(opts.channelFactory, sessionPayerAddress))
              .catch((err) => {
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
        channel: opts.channelFactory,
        commitmentKey: opts.commitmentPublicKey,
        network: networkId,
        store: wrappedStore,
        sourceAccount: payeeKeypair.publicKey(),
        feePayer: { envelopeSigner: payeeKeypair },
      }),
    ],
  })

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (req.method === 'DELETE') {
        const body = req.body as { amount?: string; signature?: string } | undefined
        const closeAmount = body?.amount ? BigInt(body.amount) : lastCumulativeAmount
        const closeSig = body?.signature ?? lastSignatureHex

        if (closeAmount > 0n && closeSig) {
          const closeTxHash = await channelClose({
            channel: opts.channelFactory,
            amount: closeAmount,
            signature: Buffer.from(closeSig, 'hex'),
            feePayer: { envelopeSigner: payeeKeypair },
            network: networkId,
          })

          // Clean close — suppress any orphan flagging for this session.
          settledCleanly = true
          clearIdleTimer()

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
                nativeToScVal(opts.channelFactory, { type: 'address' }),
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
        closeListenerArmed = false
        clearIdleTimer()
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

      // Payment verified. Detect connection teardown so a client crash mid-
      // session flags the channel for the reconciler instead of leaking
      // in-memory state and leaving the Supabase row stuck `open`.
      if (!closeListenerArmed) {
        closeListenerArmed = true
        req.on('close', () => {
          void flagOrphan('connection-closed')
        })
      }

      next()
    } catch (err) {
      next(err)
    }
  }
}

