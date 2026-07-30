/**
 * MppSessionClient — uses @stellar/mpp channel/client for off-chain
 * cumulative commitments against a pre-deployed one-way-channel contract.
 *
 * The channel is deployed and funded before the agent runs. The client
 * signs ed25519 commitments per the one-way-channel protocol — the
 * @stellar/mpp library handles the 402 challenge-response cycle.
 */
import { Keypair } from '@stellar/stellar-sdk'
import { stellar } from '@stellar/mpp/channel/client'
import { Mppx } from 'mppx/client'
import type {
  RouteDockManifest,
  SessionHandle,
  SessionCloseResult,
  StreamOptions,
  DisputeStatus,
  SessionOptions,
  SessionEvent,
  SessionTimeoutPayload,
} from '../types.js'
import { DEFAULT_MAX_SESSION_DURATION_MS } from '../types.js'
import {
  RouteDockManifestError,
  RouteDockChannelStateError,
  RouteDockSignatureError,
  RouteDockDisputeError,
  httpStatusToError,
  wrapFetchError,
} from '../errors.js'
import { withRetry, type RetryPolicy } from '../internal/retry.js'

const MIN_REFUND_WAITING_PERIOD = 17_280

export class MppSessionClient {
  constructor(
    private readonly keypair: Keypair,
    private readonly network: 'testnet' | 'mainnet',
    private readonly retryPolicy?: RetryPolicy,
  ) {}

  async openSession(
    url: string,
    manifest: RouteDockManifest,
    commitmentSecret: string,
    options?: SessionOptions,
  ): Promise<SessionHandle> {
    const pricing = manifest.pricing['mpp-session']
    if (!pricing) {
      throw new RouteDockManifestError('manifest.pricing.mpp-session missing')
    }

    const refundPeriod = pricing.refund_waiting_period_ledgers
    if (refundPeriod < MIN_REFUND_WAITING_PERIOD) {
      throw new RouteDockManifestError(
        `refund_waiting_period_ledgers ${refundPeriod} < minimum ${MIN_REFUND_WAITING_PERIOD}`,
      )
    }

    const commitmentKey = Keypair.fromSecret(commitmentSecret)
    const channelFactory = pricing.channel_factory
    const agentPublicKey = this.keypair.publicKey()
    const agentKeypair = this.keypair

    let currentCumulative = 0n
    let vouchersIssued = 0

    const mppx = Mppx.create({
      polyfill: false,
      methods: [
        stellar.channel({
          commitmentKey,
          sourceAccount: this.keypair.publicKey(),
          onProgress(event) {
            if (event.type === 'signed') {
              currentCumulative = BigInt(event.cumulativeAmount)
            }
          },
        }),
      ],
    })

    const retryPolicy = this.retryPolicy

    // ── Wall-clock lifetime guard ────────────────────────────────────────────
    // An orphaned session (e.g. a stalled agent loop) keeps channel collateral
    // locked on-chain. Auto-close after maxDurationMs so funds are never
    // stranded indefinitely. The timer is cleared as soon as the session is
    // closed manually so a normal lifecycle never triggers the guard.
    const maxDurationMs = options?.maxDurationMs ?? DEFAULT_MAX_SESSION_DURATION_MS
    const listeners = new Map<SessionEvent, Set<(payload: SessionTimeoutPayload) => void>>()
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    let closed = false

    const emit = (event: SessionEvent, payload: SessionTimeoutPayload): void => {
      const set = listeners.get(event)
      if (!set) return
      for (const listener of set) {
        try {
          listener(payload)
        } catch {
          // A misbehaving listener must not break session teardown.
        }
      }
    }

    const clearSessionTimer = (): void => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId)
        timeoutId = undefined
      }
    }

    const handle: SessionHandle = {
      channelId: channelFactory,
      // The channel is pre-deployed and funded before the agent runs, so the
      // client never issues the channel-open transaction and has no hash for
      // it. Report null rather than the contract address (a non-transaction
      // identifier that produces broken explorer links downstream).
      openTxHash: null,

      async *stream(options?: StreamOptions): AsyncIterable<unknown> {
        const concurrency = Math.max(1, options?.concurrency ?? 1)

        // Shared fetch-one helper — retries on transient errors.
        const doFetch = (): Promise<unknown> =>
          withRetry(async () => {
            let resp: Response
            try {
              resp = await mppx.fetch(url)
            } catch (err) {
              throw wrapFetchError(err, 'Voucher request')
            }
            if (!resp.ok) {
              if (resp.status >= 500 || resp.status === 429 || resp.status === 503) {
                throw httpStatusToError(
                  `Voucher request failed: HTTP ${resp.status}`,
                  resp.status,
                  resp,
                )
              }
              throw new RouteDockChannelStateError(
                `Voucher request failed: HTTP ${resp.status}`,
              )
            }
            return resp.json()
          }, retryPolicy)

        if (concurrency === 1) {
          // Default: strictly sequential.
          // The next voucher is not issued until the provider returns HTTP 200
          // for the current one, preventing out-of-order sequence numbers.
          while (true) {
            const data = await doFetch()
            vouchersIssued++
            yield data
          }
        } else {
          // Pipelined: maintain a sliding window of `concurrency` in-flight
          // requests. Results are yielded in issue order to preserve voucher
          // sequence integrity. The caller opts in knowing the provider supports
          // concurrent vouchers.
          const queue: Array<Promise<unknown>> = []
          for (let i = 0; i < concurrency; i++) queue.push(doFetch())

          while (true) {
            const data = await queue.shift()!
            // Replenish the window immediately after draining one slot.
            queue.push(doFetch())
            vouchersIssued++
            yield data
          }
        }
      },

      async close(): Promise<SessionCloseResult> {
        // Manual close — cancel the lifetime guard so it can't fire later.
        clearSessionTimer()
        closed = true

        const { rpc: rpcMod, Contract, nativeToScVal, TransactionBuilder, BASE_FEE } =
          await import('@stellar/stellar-sdk')
        const rpcUrl = 'https://soroban-testnet.stellar.org'
        const server = new rpcMod.Server(rpcUrl)
        const contract = new Contract(channelFactory)
        const passphrase = 'Test SDF Network ; September 2015'

        const account = await withRetry(async () => {
          try {
            return await server.getAccount(agentPublicKey)
          } catch (err) {
            throw wrapFetchError(err, 'Horizon getAccount')
          }
        }, retryPolicy)

        const simResult = await withRetry(async () => {
          try {
            const simTx = new TransactionBuilder(account, {
              fee: BASE_FEE,
              networkPassphrase: passphrase,
            })
              .addOperation(
                contract.call(
                  'prepare_commitment',
                  nativeToScVal(currentCumulative, { type: 'i128' }),
                ),
              )
              .setTimeout(30)
              .build()
            return await server.simulateTransaction(simTx)
          } catch (err) {
            throw wrapFetchError(err, 'prepare_commitment RPC')
          }
        }, retryPolicy)

        if (rpcMod.Api.isSimulationError(simResult)) {
          throw new RouteDockChannelStateError(
            `prepare_commitment simulation failed: ${simResult.error}`,
          )
        }

        const commitmentBytes = (
          simResult as { result?: { retval?: { bytes: () => Buffer } } }
        ).result?.retval?.bytes()
        if (!commitmentBytes) {
          throw new RouteDockChannelStateError('prepare_commitment returned no bytes')
        }

        let signature: Buffer
        try {
          signature = commitmentKey.sign(Buffer.from(commitmentBytes))
        } catch (err) {
          throw new RouteDockSignatureError('Channel close commitment signing failed', {
            cause: err,
          })
        }

        const closeData = await withRetry(async () => {
          let closeResp: Response
          try {
            closeResp = await fetch(url, {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                amount: currentCumulative.toString(),
                signature: Buffer.from(signature).toString('hex'),
              }),
            })
          } catch (err) {
            throw wrapFetchError(err, 'Channel close request')
          }

          if (!closeResp.ok) {
            if (
              closeResp.status >= 500 ||
              closeResp.status === 429 ||
              closeResp.status === 503
            ) {
              throw httpStatusToError(
                `Channel close failed: HTTP ${closeResp.status}`,
                closeResp.status,
                closeResp,
              )
            }
            throw new RouteDockChannelStateError(
              `Channel close failed: HTTP ${closeResp.status}`,
            )
          }

          const body = (await closeResp.json()) as { closeTxHash?: string }
          const closeTxHash = body.closeTxHash ?? null
          if (!closeTxHash) {
            throw new RouteDockChannelStateError(
              'Channel close response missing closeTxHash',
            )
          }
          return { closeTxHash, body }
        }, retryPolicy)

        const totalPaid = (Number(currentCumulative) / 1e7).toFixed(7)
        return {
          closeTxHash: closeData.closeTxHash,
          totalPaid,
          vouchersIssued,
        }
      },

      async requestRefund(): Promise<string> {
        const { rpc: rpcMod, Contract, TransactionBuilder, BASE_FEE } = await import('@stellar/stellar-sdk')
        const rpcUrl = 'https://soroban-testnet.stellar.org'
        const server = new rpcMod.Server(rpcUrl)
        const contract = new Contract(channelFactory)
        const passphrase = 'Test SDF Network ; September 2015'

        try {
          const account = await server.getAccount(agentPublicKey)
          const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: passphrase })
            .addOperation(contract.call('request_refund'))
            .setTimeout(30)
            .build()

          tx.sign(agentKeypair)
          const simResult = await server.simulateTransaction(tx)
          if (rpcMod.Api.isSimulationError(simResult)) {
            throw new RouteDockDisputeError(`request_refund simulation failed: ${(simResult as any).error}`)
          }

          const result = await server.sendTransaction(tx)
          if (!result.hash) {
            throw new RouteDockDisputeError('Refund request transaction not sent')
          }

          return result.hash
        } catch (err) {
          if (err instanceof RouteDockDisputeError) throw err
          throw new RouteDockDisputeError(`Failed to request refund: ${err instanceof Error ? err.message : String(err)}`)
        }
      },

      async settleWithLatestVoucher(): Promise<string> {
        const { rpc: rpcMod, Contract, nativeToScVal, TransactionBuilder, BASE_FEE } = await import('@stellar/stellar-sdk')
        const rpcUrl = 'https://soroban-testnet.stellar.org'
        const server = new rpcMod.Server(rpcUrl)
        const contract = new Contract(channelFactory)
        const passphrase = 'Test SDF Network ; September 2015'

        try {
          const account = await server.getAccount(agentPublicKey)
          const simTx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: passphrase })
            .addOperation(contract.call('prepare_commitment', nativeToScVal(currentCumulative, { type: 'i128' })))
            .setTimeout(30)
            .build()
          const simResult = await server.simulateTransaction(simTx)
          if (rpcMod.Api.isSimulationError(simResult)) {
            throw new RouteDockDisputeError(`prepare_commitment simulation failed: ${(simResult as any).error}`)
          }
          const commitmentBytes = (simResult as any).result?.retval?.bytes()
          if (!commitmentBytes) throw new RouteDockDisputeError('prepare_commitment returned no bytes')

          const signature = commitmentKey.sign(Buffer.from(commitmentBytes))

          const settleTx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: passphrase })
            .addOperation(
              contract.call(
                'settle_with_signature',
                nativeToScVal(currentCumulative, { type: 'i128' }),
                nativeToScVal(Buffer.from(signature)),
              ),
            )
            .setTimeout(30)
            .build()

          settleTx.sign(agentKeypair)
          const settleResult = await server.sendTransaction(settleTx)
          if (!settleResult.hash) {
            throw new RouteDockDisputeError('Settlement transaction not sent')
          }

          return settleResult.hash
        } catch (err) {
          if (err instanceof RouteDockDisputeError) throw err
          throw new RouteDockDisputeError(`Failed to settle with latest voucher: ${err instanceof Error ? err.message : String(err)}`)
        }
      },

      async getDisputeStatus(): Promise<DisputeStatus> {
        const { rpc: rpcMod, Contract, TransactionBuilder, BASE_FEE } = await import('@stellar/stellar-sdk')
        const rpcUrl = 'https://soroban-testnet.stellar.org'
        const server = new rpcMod.Server(rpcUrl)
        const contract = new Contract(channelFactory)
        const passphrase = 'Test SDF Network ; September 2015'

        try {
          const account = await server.getAccount(agentPublicKey)
          const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: passphrase })
            .addOperation(contract.call('get_channel_state'))
            .setTimeout(30)
            .build()

          const simResult = await server.simulateTransaction(tx)
          if (rpcMod.Api.isSimulationError(simResult)) {
            throw new RouteDockChannelStateError(`Failed to query channel state: ${(simResult as any).error}`)
          }

          const retval = (simResult as any).result?.retval
          if (!retval) {
            throw new RouteDockChannelStateError('No channel state returned')
          }

          if (typeof retval === 'object' && retval !== null) {
            const status = (retval as Record<string, unknown>).status
            if (status === 'open') return 'open'
            if (status === 'in_refund_window') return 'in-refund-window'
            if (status === 'refundable') return 'refundable'
            if (status === 'settled') return 'settled'
          }

          return 'open'
        } catch (err) {
          if (err instanceof RouteDockChannelStateError) throw err
          throw new RouteDockChannelStateError(`Failed to get dispute status: ${err instanceof Error ? err.message : String(err)}`)
        }
      },

      on(
        event: SessionEvent,
        listener: (payload: SessionTimeoutPayload) => void,
      ): () => void {
        let set = listeners.get(event)
        if (!set) {
          set = new Set()
          listeners.set(event, set)
        }
        set.add(listener)
        return () => {
          set?.delete(listener)
        }
      },
    }

    // Arm the lifetime guard once the handle exists. A non-finite or <= 0
    // budget disables the guard (caller opted out).
    if (Number.isFinite(maxDurationMs) && maxDurationMs > 0) {
      timeoutId = setTimeout(() => {
        if (closed) return
        emit('session:timeout', { maxDurationMs })
        // Best-effort auto-close; errors are surfaced to listeners via the
        // event, not thrown into the timer callback (no one would catch them).
        void handle.close().catch(() => {
          /* auto-close failed — channel may need manual recovery via refund */
        })
      }, maxDurationMs)
      // Don't keep a Node process alive solely for this safety timer.
      ;(timeoutId as { unref?: () => void }).unref?.()
    }

    return handle
  }
}
