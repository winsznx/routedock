import type { Request, Response, NextFunction, RequestHandler } from 'express'
import { Keypair } from '@stellar/stellar-sdk'
import { stellar, close as channelClose, Store } from '@stellar/mpp/channel/server'
import { Mppx, Request as MppxRequest } from 'mppx/server'
import { Store as MppxStore } from 'mppx'
import type { RouteDockManifest } from '../types.js'
import { resolveVaultSettlementAddresses } from './internal/vaultSettlement.js'
import { extractPayerAddress } from './payer.js'
import {
  channelAuthorizer,
  onVerifiedCredential,
  withTypedChannelErrors,
  type ChannelVerifyCredential,
} from './mppCompatibility.js'
import type { Method } from 'mppx'
import { resolveLogger, type RouteDockLogger } from '../internal/logger.js'

/** Store shape extended with optional atomic update operation. */
export type ChannelStore = MppxStore.Store & {
  update?: (key: string, fn: (prev: unknown) => unknown) => Promise<unknown>
}

/** Expected payload shape for voucher cumulative amount entries. */
export interface VoucherStoreValue {
  amount: string
  [key: string]: unknown
}

/** Validates that a stored store value is an object containing a numeric string amount. */
export function isVoucherStoreValue(value: unknown): value is VoucherStoreValue {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return typeof candidate.amount === 'string' && /^\d+$/.test(candidate.amount)
}

/** The last verified voucher: amount, its signature, and the payer it named. */
interface VerifiedVoucherRecord {
  amount: bigint
  signature: string
  payer: string | null
}

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
  onVoucher?: (channelId: string, voucherIndex: number, cumulativeAmount: string, signature: string) => Promise<void>
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
  /** Log sink for internal error paths. Defaults to a console-backed logger. */
  logger?: RouteDockLogger
}

export function createMppSessionHandler(opts: MppSessionHandlerOptions): RequestHandler {
  const networkId = MPP_NETWORK[opts.network]
  const rateHuman = opts.rate
  const payeeKeypair = Keypair.fromSecret(opts.payeeSecretKey)
  const logger = resolveLogger(opts.logger)
  const voucherRecordKey = `routedock:session:voucher:${opts.channelFactory}`

  const innerStore = Store.memory()

  // The last voucher mppx actually verified — amount, its signature, and the
  // payer it named. Only `commit` (called after a successful verify) may set
  // this; nothing derived from an unverified header may reach it.
  let record: VerifiedVoucherRecord | null = null
  let voucherCount = 0
  let sessionOpened = false
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

  // Unlike the Hono adapter, `innerStore` here is always a fresh
  // `Store.memory()` created inside this closure (there is no
  // `sessionStore` option to inject an externally-owned store) — so it does
  // NOT survive this handler being evicted and recreated; `record` and
  // `innerStore` are lost together. This re-read only protects against
  // `record` and `innerStore` disagreeing within a single handler's
  // lifetime, which the current code never lets happen (both are cleared
  // together on DELETE) — kept for parity with the Hono adapter and as a
  // defensive read against future changes, not as a claim that it survives
  // eviction. Never overwrites an in-memory record that is already set.
  async function loadPersistedRecord(): Promise<VerifiedVoucherRecord | null> {
    if (record) return record
    try {
      const stored = (await innerStore.get(voucherRecordKey)) as
        | { amount?: string; signature?: string; payer?: string | null }
        | undefined
      if (!stored || typeof stored.amount !== 'string' || typeof stored.signature !== 'string') {
        return null
      }
      record = { amount: BigInt(stored.amount), signature: stored.signature, payer: stored.payer ?? null }
    } catch {
      // Corrupt or unreadable persisted record — proceed as though there is none.
      return null
    }
    return record
  }

  // Flag an open-but-unsettled session for the reconciler. Idempotent: a
  // session that was cleanly settled or already flagged is left untouched.
  async function flagOrphan(reason: OrphanReason): Promise<void> {
    await loadPersistedRecord()
    if (!sessionOpened || settledCleanly) return
    sessionOpened = false
    closeListenerArmed = false
    clearIdleTimer()

    const cumulativeAmount = record ? (Number(record.amount) / 1e7).toFixed(7) : '0.0000000'
    if (opts.onOrphaned) {
      try {
        await opts.onOrphaned(opts.channelFactory, {
          cumulativeAmount,
          lastSignature: record?.signature ?? '',
          voucherCount,
          reason,
        })
      } catch (err) {
        logger('error', '[mpp-session] onOrphaned handler failed', { error: err })
      }
    }
  }

  const wrappedStore: ChannelStore = {
    async get(key: string) { return innerStore.get(key) },
    async put(key: string, value: unknown) { return innerStore.put(key, value) },
    async delete(key: string) { return innerStore.delete(key) },
    async update(key: string, fn: (prev: unknown) => unknown) {
      const storeWithUpdate = innerStore as Partial<ChannelStore>
      if (typeof storeWithUpdate.update === 'function') {
        return storeWithUpdate.update(key, fn)
      }
      throw new Error('Store does not support atomic update operations')
    },
  }

  // Called only after mppx has verified a credential — never before. Commits
  // the verified amount/signature/payer as the new record, then runs the
  // bookkeeping (voucher count, idle timer, onSessionOpen/onVoucher) that used
  // to run inside the store's `put`, before the caller knew verification had
  // actually succeeded.
  async function commit(credential: ChannelVerifyCredential): Promise<void> {
    await loadPersistedRecord()
    const payload = credential.payload
    if (typeof payload?.amount !== 'string' || typeof payload.signature !== 'string') return
    let amount: bigint
    try {
      amount = BigInt(payload.amount)
    } catch {
      return
    }
    // A late/duplicate commit can't roll the signature back to an earlier amount.
    if (record && amount < record.amount) return

    const payer = record?.payer ?? extractPayerAddress(credential.source)
    record = { amount, signature: payload.signature, payer }
    await innerStore.put(voucherRecordKey, {
      amount: record.amount.toString(),
      signature: record.signature,
      payer: record.payer,
    })

    voucherCount++
    settledCleanly = false
    armIdleTimer()

    if (!sessionOpened) {
      sessionOpened = true
      if (opts.onSessionOpen) {
        Promise.resolve()
          .then(() => opts.onSessionOpen!(opts.channelFactory, record!.payer))
          .catch((err) => {
            logger('error', '[mpp-session] onSessionOpen callback error', { error: err })
            opts.onCallbackError?.(err, 'onSessionOpen')
          })
      }
    }
    if (opts.onVoucher) {
      const humanAmount = (Number(record.amount) / 1e7).toFixed(7)
      Promise.resolve().then(() => opts.onVoucher!(opts.channelFactory, voucherCount, humanAmount, record!.signature)).catch(err => {
        logger('error', '[mpp-session] onVoucher callback error', { error: err })
        opts.onCallbackError?.(err, 'onVoucher')
      })
    }
  }

  const mppx = Mppx.create({
    secretKey: opts.payeeSecretKey,
    methods: [
      withTypedChannelErrors(
        onVerifiedCredential(
          stellar.channel({
            channel: opts.channelFactory,
            commitmentKey: opts.commitmentPublicKey,
            network: networkId,
            store: wrappedStore,
            sourceAccount: payeeKeypair.publicKey(),
            feePayer: channelAuthorizer(payeeKeypair),
          }) as Method.AnyServer,
          commit,
        ),
      ),
    ],
  })

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      if (req.method === 'DELETE') {
        await loadPersistedRecord()
        const body = req.body as { amount?: string; signature?: string } | undefined
        const bodyAmount = body?.amount ? BigInt(body.amount) : 0n
        const recordAmount = record?.amount ?? 0n
        let closeAmount: bigint
        let closeSig: string
        if (bodyAmount > recordAmount) {
          closeAmount = bodyAmount
          closeSig = body?.signature ?? record?.signature ?? ''
        } else {
          closeAmount = recordAmount
          closeSig = record?.signature ?? ''
        }

        if (closeAmount > 0n && closeSig) {
          const closePayer = record?.payer ?? null
          const closeTxHash = await channelClose({
            channel: opts.channelFactory,
            amount: closeAmount,
            signature: Buffer.from(closeSig, 'hex'),
            feePayer: channelAuthorizer(payeeKeypair),
            network: networkId,
          })

          // Clean close — suppress any orphan flagging for this session.
          settledCleanly = true
          clearIdleTimer()

          if (opts.onSettled) {
            const totalPaid = (Number(closeAmount) / 1e7).toFixed(7)
            Promise.resolve().then(() => opts.onSettled!(closeTxHash, totalPaid, 'mpp-session', closePayer)).catch(err => {
              logger('error', '[mpp-session] onSettled callback error', { error: err })
              opts.onCallbackError?.(err, 'onSettled')
            })
          }

          // Optionally record session_settled on the agent vault.
          // Requires AGENT_VAULT_CONTRACT and AGENT_VAULT_ADMIN_SECRET env vars.
          const vaultContract = process.env.AGENT_VAULT_CONTRACT
          const vaultAdminSecret = process.env.AGENT_VAULT_ADMIN_SECRET
          if (vaultContract && vaultAdminSecret) {
            const settlementAddresses = resolveVaultSettlementAddresses(
              closePayer,
              payeeKeypair.publicKey(),
            )
            if (!settlementAddresses) {
              logger('warn', '[mpp-session] skipped session_settled vault record: payer address unavailable')
            } else {
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
                  nativeToScVal(settlementAddresses.payer, { type: 'address' }),
                  nativeToScVal(settlementAddresses.payee, { type: 'address' }),
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
                logger('error', '[mpp-session] failed to record session_settled on vault', { error: recordErr })
              }
            }
          }

          res.json({ closeTxHash })
        } else {
          res.json({ closeTxHash: null, message: 'no vouchers received' })
        }

        sessionOpened = false
        voucherCount = 0
        record = null
        await innerStore.delete(voucherRecordKey)
        closeListenerArmed = false
        clearIdleTimer()
        return
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
