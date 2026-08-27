/**
 * MppSessionClient — uses @stellar/mpp channel/client for off-chain
 * cumulative commitments against a pre-deployed one-way-channel contract.
 *
 * The channel is deployed and funded before the agent runs. The client
 * signs ed25519 commitments per the one-way-channel protocol — the
 * @stellar/mpp library handles the 402 challenge-response cycle.
 */
import { Keypair, Networks } from '@stellar/stellar-sdk'
import { stellar } from '@stellar/mpp/channel/client'
import { Mppx } from 'mppx/client'
import type {
  RouteDockManifest,
  SessionHandle,
  SessionCloseResult,
  SessionStats,
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

/** WebSocket-readyState values (mirrors the WHATWG WebSocket constants). */
const WS_CONNECTING = 0
const WS_OPEN = 1

/** A WebSocket socket as consumed by the mpp-session-ws stream. */
export interface WebSocketLike {
  readyState: number
  close(code?: number, reason?: string): void
}

/** Callbacks a WebSocket factory must wire to the underlying socket. */
export interface WebSocketHandlers {
  onOpen(): void
  onMessage(data: string): void
  onClose(code: number, reason: string): void
  onError(): void
}

/**
 * Creates a WebSocket connection with the given handshake headers.
 * Injected for testability; defaults to the runtime WebSocket global
 * (undici in Node ≥ 22 supports handshake headers via its options object).
 */
export type WebSocketFactory = (
  url: string,
  init: { headers: Record<string, string> },
  handlers: WebSocketHandlers,
) => WebSocketLike

function defaultWebSocketFactory(
  url: string,
  init: { headers: Record<string, string> },
  handlers: WebSocketHandlers,
): WebSocketLike {
  // Node ≥ 22 (undici) extends the WebSocket constructor with an options
  // object that carries handshake headers — the DOM types only know the
  // protocols argument, so cast through the constructor's parameter type.
  const socket = new WebSocket(
    url,
    { headers: init.headers } as unknown as ConstructorParameters<typeof WebSocket>[1],
  )
  socket.onopen = () => handlers.onOpen()
  socket.onmessage = (event) => {
    const data = event.data
    if (typeof data === 'string') {
      handlers.onMessage(data)
    } else if (data instanceof ArrayBuffer) {
      handlers.onMessage(Buffer.from(data).toString('utf8'))
    } else {
      // Blob or other binary — best-effort decode.
      void (data as Blob)
        .arrayBuffer()
        .then((buffer) => handlers.onMessage(Buffer.from(buffer).toString('utf8')))
        .catch(() => {
          /* undecodable frame — dropped */
        })
    }
  }
  socket.onclose = (event) => handlers.onClose(event.code, event.reason)
  socket.onerror = () => handlers.onError()
  return socket
}

/** The subset of the mppx client used by the WebSocket transport. */
interface WsMppxLike {
  rawFetch: typeof globalThis.fetch
  createCredential: (response: Response) => Promise<string>
}

export class MppSessionClient {
  constructor(
    private readonly keypair: Keypair,
    private readonly network: 'testnet' | 'mainnet',
    private readonly retryPolicy?: RetryPolicy,
    private readonly webSocketFactory: WebSocketFactory = defaultWebSocketFactory,
  ) {}

  async openSession(
    url: string,
    manifest: RouteDockManifest,
    commitmentSecret: string,
    options?: SessionOptions,
    onSpend?: (amount: string) => Promise<void>,
  ): Promise<SessionHandle> {
    const mode = options?.mode ?? 'mpp-session'
    const pricing = manifest.pricing[mode]
    if (!pricing) {
      throw new RouteDockManifestError(`manifest.pricing.${mode} missing`)
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

    // Bound before the handle literal so the transport can be selected inside
    // the SessionHandle (whose `this` is the handle, not this client).
    const streamWs = (u: string, m: WsMppxLike): AsyncIterable<unknown> =>
      this.streamWebSocket(u, m)

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

    const network = this.network

    const handle: SessionHandle = {
      channelId: channelFactory,
      // The channel is pre-deployed and funded before the agent runs, so the
      // client never issues the channel-open transaction and has no hash for
      // it. Report null rather than the contract address (a non-transaction
      // identifier that produces broken explorer links downstream).
      openTxHash: null,

      /**
       * Live session snapshot. Both counters are closure state written during
       * stream(): vouchersIssued is incremented before each yield and
       * currentCumulative is updated by the channel client's onProgress when a
       * voucher is signed, so a stats() call immediately after a yield always
       * reflects everything consumed so far.
       */
      stats() {
        return {
          vouchersIssued,
          // Same conversion as SessionCloseResult.totalPaid so a per-session
          // sub-cap can be compared against stats().currentCumulative directly.
          currentCumulative: (Number(currentCumulative) / 1e7).toFixed(7),
          channelId: channelFactory,
          openTxHash: null,
        }
      },

      async *stream(options?: StreamOptions): AsyncIterable<unknown> {
        if (mode === 'mpp-session-ws') {
          // WebSocket transport: one connection per stream() call, with one
          // voucher negotiated over HTTP before the upgrade. Each connection
          // counts as one voucher issued.
          for await (const item of streamWs(url, mppx)) {
            vouchersIssued++
            yield item
          }
          return
        }

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

        // Check the local daily spend cap before issuing each voucher.
        const checkSpend = (): Promise<void> => {
          if (!onSpend) return Promise.resolve()
          return onSpend(pricing.rate)
        }

        if (concurrency === 1) {
          // Default: strictly sequential.
          // The next voucher is not issued until the provider returns HTTP 200
          // for the current one, preventing out-of-order sequence numbers.
          while (true) {
            await checkSpend()
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
          for (let i = 0; i < concurrency; i++) {
            await checkSpend()
            queue.push(doFetch())
          }

          while (true) {
            const data = await queue.shift()!
            // Replenish the window immediately after draining one slot.
            await checkSpend()
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
        const rpcUrl = network === 'testnet'
          ? 'https://soroban-testnet.stellar.org'
          : 'https://soroban.stellar.org'
        const server = new rpcMod.Server(rpcUrl)
        const contract = new Contract(channelFactory)
        const passphrase = network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET

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
        const rpcUrl = network === 'testnet'
          ? 'https://soroban-testnet.stellar.org'
          : 'https://soroban.stellar.org'
        const server = new rpcMod.Server(rpcUrl)
        const contract = new Contract(channelFactory)
        const passphrase = network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET

        try {
          const account = await server.getAccount(agentPublicKey)
          const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: passphrase })
            .addOperation(contract.call('request_refund'))
            .setTimeout(30)
            .build()

          const simResult = await server.simulateTransaction(tx)
          if (rpcMod.Api.isSimulationError(simResult)) {
            throw new RouteDockDisputeError(`request_refund simulation failed: ${(simResult as any).error}`)
          }

          const preparedTx = await server.prepareTransaction(tx)
          preparedTx.sign(agentKeypair)

          const result = await server.sendTransaction(preparedTx)
          if (result.status === 'ERROR') {
            const errDetail = (result as any).errorResult ? JSON.stringify((result as any).errorResult) : 'status ERROR'
            throw new RouteDockDisputeError(`Refund request transaction failed: ${errDetail}`)
          }
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
        const rpcUrl = network === 'testnet'
          ? 'https://soroban-testnet.stellar.org'
          : 'https://soroban.stellar.org'
        const server = new rpcMod.Server(rpcUrl)
        const contract = new Contract(channelFactory)
        const passphrase = network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET

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

          const settleAccount = await server.getAccount(agentPublicKey)
          const settleTx = new TransactionBuilder(settleAccount, { fee: BASE_FEE, networkPassphrase: passphrase })
            .addOperation(
              contract.call(
                'settle_with_signature',
                nativeToScVal(currentCumulative, { type: 'i128' }),
                nativeToScVal(Buffer.from(signature)),
              ),
            )
            .setTimeout(30)
            .build()

          const preparedSettleTx = await server.prepareTransaction(settleTx)
          preparedSettleTx.sign(agentKeypair)
          const settleResult = await server.sendTransaction(preparedSettleTx)
          if (settleResult.status === 'ERROR') {
            const errDetail = (settleResult as any).errorResult ? JSON.stringify((settleResult as any).errorResult) : 'status ERROR'
            throw new RouteDockDisputeError(`Settlement transaction failed: ${errDetail}`)
          }
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
        const rpcUrl = network === 'testnet'
          ? 'https://soroban-testnet.stellar.org'
          : 'https://soroban.stellar.org'
        const server = new rpcMod.Server(rpcUrl)
        const contract = new Contract(channelFactory)
        const passphrase = network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET

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

  /**
   * mpp-session-ws streaming transport.
   *
   * Mirrors the issue's three-step sequence:
   *   1. open the channel — probe the provider URL over HTTP;
   *   2. negotiate the voucher — sign the mppx 402 challenge into a credential;
   *   3. upgrade the HTTP connection to WebSocket — hand the signed voucher to
   *      the provider as the Authorization header of the WebSocket handshake.
   *
   * Each server frame is yielded (JSON frames parsed; raw strings yielded
   * as-is). The stream ends when the server closes the socket with a normal
   * close code (1000/1001); abnormal closes and connection failures surface as
   * RouteDockChannelStateError.
   */
  private async *streamWebSocket(
    url: string,
    mppx: WsMppxLike,
  ): AsyncIterable<unknown> {
    // ── 1 + 2: channel establishment + voucher negotiation over HTTP ────────
    const request: RequestInit = { method: 'GET' }
    let probe: Response
    try {
      probe = await mppx.rawFetch(url, request)
    } catch (err) {
      throw wrapFetchError(err, 'Voucher request')
    }
    if (probe.status !== 402) {
      if (probe.status >= 500 || probe.status === 429 || probe.status === 503) {
        throw httpStatusToError(
          `Voucher request failed: HTTP ${probe.status}`,
          probe.status,
          probe,
        )
      }
      throw new RouteDockChannelStateError(
        `Voucher request failed: expected HTTP 402 challenge, got HTTP ${probe.status}`,
      )
    }

    let credential: string
    try {
      credential = await mppx.createCredential(probe)
    } catch (err) {
      throw wrapFetchError(err, 'Voucher credential')
    }

    // ── 3: upgrade the HTTP connection to WebSocket ─────────────────────────
    const wsUrl = url.replace(/^http/, 'ws')

    type WsEvent =
      | { type: 'open' }
      | { type: 'message'; data: string }
      | { type: 'close'; code: number; reason: string }
      | { type: 'error' }

    const queue: WsEvent[] = []
    const waiters: Array<(event: WsEvent) => void> = []

    const drain = (): void => {
      while (queue.length > 0 && waiters.length > 0) {
        const waiter = waiters.shift()!
        waiter(queue.shift()!)
      }
    }
    const nextEvent = (): Promise<WsEvent> =>
      queue.length > 0
        ? Promise.resolve(queue.shift()!)
        : new Promise((resolve) => {
            waiters.push(resolve)
          })

    const socket = this.webSocketFactory(
      wsUrl,
      { headers: { authorization: credential } },
      {
        onOpen: () => {
          queue.push({ type: 'open' })
          drain()
        },
        onMessage: (data) => {
          queue.push({ type: 'message', data })
          drain()
        },
        onClose: (code, reason) => {
          queue.push({ type: 'close', code, reason })
          drain()
        },
        onError: () => {
          queue.push({ type: 'error' })
          drain()
        },
      },
    )

    try {
      // Await the upgrade: 'open' means the provider accepted the signed
      // voucher and switched protocols; error/close before open is a rejected
      // handshake.
      for (;;) {
        const event = await nextEvent()
        if (event.type === 'open') break
        if (event.type === 'error') {
          throw new RouteDockChannelStateError(
            'WebSocket upgrade failed: connection error',
          )
        }
        if (event.type === 'close') {
          throw new RouteDockChannelStateError(
            `WebSocket upgrade failed: server closed the connection before upgrading (code ${event.code})`,
          )
        }
      }

      // Stream frames until the provider closes the socket.
      for (;;) {
        const event = await nextEvent()
        if (event.type === 'message') {
          let parsed: unknown = event.data
          try {
            parsed = JSON.parse(event.data)
          } catch {
            // Non-JSON frame — yield the raw payload.
          }
          yield parsed
          continue
        }
        if (event.type === 'error') {
          throw new RouteDockChannelStateError('WebSocket connection error')
        }
        // A second 'open' cannot arrive after the upgrade; guard only to keep
        // the union narrow for the close branch below.
        if (event.type === 'open') continue
        // close — normal codes end the stream; abnormal codes are errors.
        if (event.code === 1000 || event.code === 1001) {
          return
        }
        throw new RouteDockChannelStateError(
          `WebSocket stream ended abnormally (code ${event.code}${event.reason ? `: ${event.reason}` : ''})`,
        )
      }
    } finally {
      // Consumer stopped iterating or the stream ended — tear down the socket
      // so the provider sees a clean close and can flag/settle the channel.
      if (socket.readyState === WS_CONNECTING || socket.readyState === WS_OPEN) {
        socket.close(1000, 'stream ended')
      }
    }
  }
}
