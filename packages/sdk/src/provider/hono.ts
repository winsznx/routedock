import { assertProviderConfig } from './internal/assertProviderConfig.js'
import type { MiddlewareHandler } from 'hono'
import { Keypair } from '@stellar/stellar-sdk'
import { ExactStellarScheme as ExactStellarFacilitatorScheme } from '@x402/stellar/exact/facilitator'
import { ExactStellarScheme as ExactStellarServerScheme } from '@x402/stellar/exact/server'
import { HTTPFacilitatorClient, x402ResourceServer } from '@x402/core/server'
import { createEd25519Signer } from '@x402/stellar'
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from '@x402/core/http'
import type { Network as X402Network } from '@x402/core/types'
import { stellar as mppCharge } from '@stellar/mpp/charge/server'
import { stellar as mppChannel, close as channelClose, Store } from '@stellar/mpp/channel/server'
import { Mppx } from 'mppx/server'
import type { RouteDockManifest, PaymentMode } from '../types.js'
import { signManifest } from '../manifest/sign.js'
import { resolvePayee } from '../internal/payee.js'
import { usdcToUnits } from '../internal/usdc.js'
import { extractPayerAddress } from './payer.js'
import { resolveLogger, type RouteDockLogger } from '../internal/logger.js'
import {
  channelAuthorizer,
  onVerifiedCredential,
  withTypedChannelErrors,
  type ChannelVerifyCredential,
} from './mppCompatibility.js'
import { Credential, type Method } from 'mppx'
import { type ChannelStore, type OrphanedSessionInfo } from './MppSessionHandler.js'
import { base64ToUtf8, hexToBytes } from './encoding.js'
import {
  InMemorySeenTxStore,
  paymentIdempotencyKey,
  checkSettlementReplay,
  recordSettlement,
  type SeenTxStore,
} from './SeenTxStore.js'
import { resolveAssetContract } from '../internal/assetUtils.js'
import { RouteDockManifestError } from '../errors.js'
import { readSettleResult } from '../internal/settleResult.js'
import { recordSessionSettlement } from './internal/vaultSettlement.js'
import {
  resolveVaultSettlementConfig,
  type VaultSettlementConfig,
} from '../internal/vaultConfig.js'

type Network = 'testnet' | 'mainnet'

const CAIP2: Record<Network, X402Network> = {
  testnet: 'stellar:testnet',
  mainnet: 'stellar:pubnet',
}

const OZ_FACILITATOR_URL = 'https://channels.openzeppelin.com/x402'

export interface RouteDockHonoOptions {
  modes: PaymentMode[]
  pricing: {
    x402?: string
    'mpp-charge'?: string
    'mpp-session'?: { rate: string; channelFactory: string; channels?: string[] }
    /** WebSocket transport variant of mpp-session — same channel, WS streaming */
    'mpp-session-ws'?: { rate: string; channelFactory: string; channels?: string[] }
  }
  asset?: string
  assetContract?: string
  payee: string
  network: Network
  payeeSecretKey: string
  facilitatorApiKey?: string
  commitmentPublicKey?: string
  manifest: RouteDockManifest
  onSettled?: (
    txHash: string,
    amount: string,
    mode: string,
    payer: string | null,
    channelId?: string,
  ) => Promise<void>
  onSessionOpen?: (channelId: string, payer: string | null) => Promise<void>
  onVoucher?: (channelId: string, voucherIndex: number, cumulativeAmount: string, signature: string) => Promise<void>
  onCallbackError?: (err: unknown, cbName: string) => void
  /**
   * Called when an mpp-session connection aborts or goes idle before a clean
   * close. Persist the session as `closing` for the SessionReconciler.
   */
  onOrphaned?: (channelId: string, info: OrphanedSessionInfo) => Promise<void>
  /** Idle timeout (ms) after which an mpp-session is flagged orphaned. */
  idleTimeoutMs?: number
  /**
   * Idempotency store guarding against duplicate settlement when an agent
   * retries the same payment. Defaults to a per-handler in-memory store.
   */
  seenTxStore?: SeenTxStore
  /**
   * Persistent store backing mpp-session channel state and handler state.
   * Defaults to an in-memory store per handler; supply a durable store (e.g.
   * Durable Object storage) so voucher tracking survives isolate eviction.
   */
  sessionStore?: Store.Store | undefined
  /** Log sink for internal error paths. Defaults to a console-backed logger. */
  logger?: RouteDockLogger
  /**
   * Record `session_settled` on the agent vault after each clean mpp-session
   * close. `contract` is the vault's C... id; `rpcUrl` overrides the default
   * Soroban RPC endpoint for the configured network. The vault authorizes
   * the record with the payee's own key, so no admin secret is ever held.
   */
  vaultSettlement?: VaultSettlementConfig
  /**
   * Receives background promises (currently the vault settlement record) so
   * the runtime keeps the request alive until they finish — pass
   * `ctx.waitUntil` on Cloudflare Workers. Without it, settlement still runs
   * but the runtime may evict the isolate before it completes.
   */
  waitUntil?: (promise: Promise<unknown>) => void
}

function createX402HonoHandler(opts: RouteDockHonoOptions): MiddlewareHandler {
  const caip2 = CAIP2[opts.network]
  const payeeKeypair = Keypair.fromSecret(opts.payeeSecretKey)
  const signer = createEd25519Signer(opts.payeeSecretKey, caip2)
  const x402Price = opts.pricing.x402!
  const logger = resolveLogger(opts.logger)
  const seenTxStore = opts.seenTxStore ?? new InMemorySeenTxStore({ logger })

  const useOzFacilitator = opts.network === 'mainnet' && opts.facilitatorApiKey

  const localFacilitator = new ExactStellarFacilitatorScheme([signer], {
    areFeesSponsored: true,
  })

  let ozServer: x402ResourceServer | null = null
  if (useOzFacilitator) {
    const apiKey = opts.facilitatorApiKey!
    const facilitator = new HTTPFacilitatorClient({
      url: OZ_FACILITATOR_URL,
      createAuthHeaders: async () => ({
        verify: { Authorization: `Bearer ${apiKey}` },
        settle: { Authorization: `Bearer ${apiKey}` },
        supported: { Authorization: `Bearer ${apiKey}` },
      }),
    })
    ozServer = new x402ResourceServer(facilitator)
    ozServer.register(caip2, new ExactStellarServerScheme())
  }

  const amountInBaseUnits = String(usdcToUnits(x402Price))

  return async (c, next) => {
    try {
      const endpoint = c.req.path
      const assetContract = resolveAssetContract(
        opts.manifest,
        'x402',
        endpoint,
        opts.assetContract,
      )
      const requirements = {
        scheme: 'exact' as const,
        network: caip2,
        asset: assetContract,
        amount: amountInBaseUnits,
        payTo: resolvePayee(opts.manifest, 'x402'),
        maxTimeoutSeconds: 60,
        extra: {
          areFeesSponsored: true,
          ...(useOzFacilitator ? {} : { facilitatorAddresses: [payeeKeypair.publicKey()] }),
        },
      }

      // Shared unpaid/failed-settlement response: it always carries the same
      // payment requirements header an unpaid request would, so the agent can
      // retry, and never an X-Payment-Response header. It is defined here
      // because the requirements depend on the asset contract resolved for this
      // request's endpoint.
      const respondPaymentRequired = async (error: string, reason?: string) => {
        if (ozServer) {
          const resourceInfo = {
            url: c.req.url,
            description: opts.manifest.name,
          }
          const paymentRequired = await ozServer.createPaymentRequiredResponse(
            [requirements],
            resourceInfo,
          )
          c.header('X-Payment-Requirements', encodePaymentRequiredHeader(paymentRequired))
        } else {
          const x402Response = {
            x402Version: 2,
            resource: { url: c.req.url, description: opts.manifest.name },
            accepts: [requirements],
          }
          c.header('X-Payment-Requirements', encodePaymentRequiredHeader(x402Response))
        }
        return c.json({ error, ...(reason ? { reason } : {}) }, 402)
      }

      const paymentHeader = c.req.header('payment-signature') ?? c.req.header('x-payment')

      if (!paymentHeader) {
        return respondPaymentRequired('Payment Required')
      }

      // Idempotency: a retry of an already-settled payment replays the cached
      // settlement response instead of settling (and billing) a second time.
      // The key is scoped to this route so a payment settled elsewhere can
      // never replay here, and replays are capped + time-bounded.
      const idempotencyKey = await paymentIdempotencyKey(
        (name) => c.req.header(name),
        {
          method: c.req.method,
          path: c.req.path,
          amount: requirements.amount,
          payTo: requirements.payTo,
        },
      )
      if (idempotencyKey) {
        const replayCheck = await checkSettlementReplay(seenTxStore, idempotencyKey)
        if (replayCheck.kind === 'spent') {
          return c.json({ error: 'Payment already used' }, 402)
        }
        if (replayCheck.kind === 'replay') {
          if (replayCheck.record.headers) {
            for (const [k, val] of Object.entries(replayCheck.record.headers)) {
              c.header(k, val)
            }
          }
          await next()
          return
        }
      }

      const payload = decodePaymentSignatureHeader(paymentHeader)
      let txHash: string | null = null
      let paymentResponseHeader: string | undefined
      // Extract payer public key from the x402 Stellar payload.
      let payerAddress: string | null = null
      try {
        const creds = (
          payload as unknown as {
            authorization?: { credentials?: Array<{ publicKey?: string }> }
          }
        ).authorization?.credentials
        const key = Array.isArray(creds) ? creds[0]?.publicKey : undefined
        payerAddress = extractPayerAddress(key)
      } catch {
        // non-fatal
      }

      if (ozServer) {
        const settleResult = await ozServer.settlePayment(payload, requirements)
        const outcome = readSettleResult(settleResult)
        if (!outcome.ok) {
          return respondPaymentRequired('Payment settlement failed', outcome.reason)
        }
        txHash = outcome.txHash
        paymentResponseHeader = encodePaymentResponseHeader(
          settleResult as Parameters<typeof encodePaymentResponseHeader>[0],
        )
        c.header('X-Payment-Response', paymentResponseHeader)
      } else {
        const verifyResult = await localFacilitator.verify(
          payload as Parameters<typeof localFacilitator.verify>[0],
          requirements,
        )
        if (!verifyResult.isValid) {
          // Same shape as a settlement failure: 402 + fresh requirements + reason,
          // so a protocol-following client can retry or report why it was refused.
          return respondPaymentRequired(
            'Payment verification failed',
            (verifyResult as { invalidReason?: string }).invalidReason,
          )
        }
        const settleResult = await localFacilitator.settle(
          payload as Parameters<typeof localFacilitator.settle>[0],
          requirements,
        )
        const outcome = readSettleResult(settleResult)
        if (!outcome.ok) {
          return respondPaymentRequired('Payment settlement failed', outcome.reason)
        }
        txHash = outcome.txHash
        paymentResponseHeader = encodePaymentResponseHeader(
          settleResult as Parameters<typeof encodePaymentResponseHeader>[0],
        )
        c.header('X-Payment-Response', paymentResponseHeader)
      }

      // Record the settlement so a retry of this exact payment is deduped.
      if (idempotencyKey) {
        const headers: Record<string, string> = {}
        if (paymentResponseHeader) headers['X-Payment-Response'] = paymentResponseHeader
        await recordSettlement(
          seenTxStore,
          idempotencyKey,
          { txHash, headers, createdAt: Date.now() },
          { logger, label: '[x402]', onCallbackError: opts.onCallbackError },
        )
      }

      if (txHash && opts.onSettled) {
        Promise.resolve().then(() => opts.onSettled!(txHash!, x402Price, 'x402', payerAddress)).catch(err => {
          logger('error', '[x402] onSettled callback error', { error: err })
          opts.onCallbackError?.(err, 'onSettled')
        })
      }

      await next()
    } catch (err) {
      if (err instanceof RouteDockManifestError) {
        throw err
      }
      logger('error', '[x402] Settlement error', { error: err })
      return c.json({ error: 'Payment settlement failed' }, 500)
    }
  }
}

function createMppChargeHonoHandler(opts: RouteDockHonoOptions): MiddlewareHandler {
  const networkId = CAIP2[opts.network] as 'stellar:testnet' | 'stellar:pubnet'
  const chargePrice = opts.pricing['mpp-charge']!
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
          mppCharge({
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

  return async (c, next) => {
    try {
      const endpoint = c.req.path
      const assetContract = resolveAssetContract(
        opts.manifest,
        'mpp-charge',
        endpoint,
        opts.assetContract,
      )
      const mppx = getMppx(assetContract)
      // Extract payer public key from the mppx Payment authorization header.
      let payerAddress: string | null = null
      try {
        const authHeader = c.req.header('authorization')
        if (authHeader?.startsWith('Payment ')) {
          const credPart = authHeader
            .replace(/^Payment\s+/, '')
            .split(',')
            .find((p) => p.trim().startsWith('credential='))
          if (credPart) {
            const b64 = credPart.split('=').slice(1).join('=').replace(/^"|"$/g, '')
            const credJson = base64ToUtf8(b64)
            const cred = JSON.parse(credJson) as {
              sender?: string
              payload?: { sender?: string; from?: string }
            }
            const key = cred.sender ?? cred.payload?.sender ?? cred.payload?.from
            payerAddress = extractPayerAddress(key)
          }
        }
      } catch {
        // non-fatal
      }

      // Idempotency: a retry of an already-settled charge replays the cached
      // receipt headers instead of settling (and billing) a second time. The
      // key is scoped to this route and replays are capped + time-bounded.
      const idempotencyKey = await paymentIdempotencyKey(
        (name) => c.req.header(name),
        {
          method: c.req.method,
          path: c.req.path,
          amount: chargePrice,
          payTo: recipient,
        },
      )
      if (idempotencyKey) {
        const replayCheck = await checkSettlementReplay(seenTxStore, idempotencyKey)
        if (replayCheck.kind === 'spent') {
          return c.json({ error: 'Payment already used' }, 402)
        }
        if (replayCheck.kind === 'replay') {
          if (replayCheck.record.headers) {
            for (const [k, val] of Object.entries(replayCheck.record.headers)) {
              c.header(k, val)
            }
          }
          await next()
          return
        }
      }

      const handler = (
        mppx as unknown as {
          'stellar/charge': (o: {
            amount: string
            currency: string
            recipient: string
            description?: string
          }) => (input: globalThis.Request) => Promise<{
            status: 402 | 200
            challenge?: globalThis.Response
            withReceipt?: (r: globalThis.Response) => globalThis.Response
          }>
        }
      )['stellar/charge']

      const result = await handler({
        amount: chargePrice,
        currency: assetContract,
        recipient,
        description: opts.manifest.name,
      })(c.req.raw)

      if (result.status === 402) {
        const challenge = result.challenge!
        const headers: Record<string, string> = {}
        challenge.headers.forEach((v: string, k: string) => { headers[k] = v })
        return new Response(await challenge.text(), { status: 402, headers })
      }

      const receipt = result.withReceipt!(new Response(''))
      const receiptHeaders: Record<string, string> = {}
      receipt.headers.forEach((v: string, k: string) => {
        c.header(k, v)
        receiptHeaders[k] = v
      })

      const receiptHeader = receipt.headers.get('payment-receipt')
      let reference: string | undefined
      if (receiptHeader) {
        try {
          const parsed = JSON.parse(base64ToUtf8(receiptHeader)) as { reference?: string }
          reference = parsed.reference
        } catch {
          // non-fatal — receipt is opaque/unparseable
        }
      }

      // Record the settlement so a retry of this exact charge is deduped.
      if (idempotencyKey) {
        await recordSettlement(
          seenTxStore,
          idempotencyKey,
          { txHash: reference ?? null, headers: receiptHeaders, createdAt: Date.now() },
          { logger, label: '[mpp-charge]', onCallbackError: opts.onCallbackError },
        )
      }

      if (reference && opts.onSettled) {
        Promise.resolve().then(() => opts.onSettled!(reference!, chargePrice, 'mpp-charge', payerAddress)).catch(err => {
          logger('error', '[mpp-charge] onSettled callback error', { error: err })
          opts.onCallbackError?.(err, 'onSettled')
        })
      }

      await next()
    } catch (err) {
      if (err instanceof RouteDockManifestError) {
        throw err
      }
      logger('error', '[mpp-charge] Settlement error', { error: err })
      return c.json({ error: 'Payment settlement failed' }, 500)
    }
  }
}

/**
 * Context key set by the mpp-session-ws middleware after a request's payment
 * credential has been verified, so the app's WebSocket upgrade route can
 * refuse to upgrade unauthenticated handshakes.
 */
export const MPP_SESSION_WS_VERIFIED = 'routedock.mppSessionWs.verified'

/**
 * True when the routedockHono mpp-session-ws middleware verified the
 * handshake request's Payment credential (see {@link MPP_SESSION_WS_VERIFIED}).
 * WebSocket upgrade routes should refuse to upgrade when this is false.
 */
export function mppSessionWsVerified(c: { get: (key: string) => unknown }): boolean {
  return c.get(MPP_SESSION_WS_VERIFIED) === true
}

/** Contexts the shared session state is invoked with (subset of hono's Context). */
interface DeleteContext {
  req: {
    json(): Promise<unknown>
    header?: (name: string) => string | undefined
  }
  json: (data: unknown, status?: number) => Response
}
interface SignalContext {
  req: { raw: { signal?: AbortSignal } }
}

/**
 * Resolve the channel contract address named by a verified credential,
 * falling back to `defaultChannel` when none is specified on the credential.
 */
function resolveCredentialChannel(
  credential: ChannelVerifyCredential | undefined | null,
  defaultChannel: string,
): string {
  const fromChallenge = credential?.challenge?.request?.channel
  if (typeof fromChallenge === 'string' && fromChallenge.length > 0) {
    return fromChallenge
  }
  const fromPayload = credential?.payload?.channel
  if (typeof fromPayload === 'string' && fromPayload.length > 0) {
    return fromPayload
  }
  const fromTop = credential?.channel
  if (typeof fromTop === 'string' && fromTop.length > 0) {
    return fromTop
  }
  return defaultChannel
}

/**
 * Extract the channel contract address from an incoming request's `x-channel-id`
 * header or `Authorization: Payment <base64url>` credential (`challenge.request.channel`).
 */
function extractRequestChannel(
  getHeader?: (name: string) => string | undefined,
): string | null {
  if (typeof getHeader !== 'function') return null
  const explicit = getHeader('x-channel-id')
  if (typeof explicit === 'string' && explicit.trim().length > 0) {
    return explicit.trim()
  }
  const auth = getHeader('authorization')
  if (!auth) return null
  try {
    const payment = Credential.extractPaymentScheme(auth)
    if (!payment) return null
    const cred = Credential.deserialize(payment) as ChannelVerifyCredential
    const resolved = resolveCredentialChannel(cred, '')
    return resolved.length > 0 ? resolved : null
  } catch {
    return null
  }
}

/**
 * Mutable per-channel session state shared by the mpp-session and
 * mpp-session-ws handlers. Keyed by channel ID so multiple agents with
 * different deployed channels can stream and close sessions against one
 * provider deployment without colliding on `routedock:session:voucher:<channelId>`
 * or `sessions.channel_id` (#550).
 */
interface MppSessionHandlerState {
  /** Default mppx server instance (channel method) for `channelFactory`. */
  mppx: unknown
  /** Resolve an mppx server instance for a specific channel ID (or default). */
  getMppx(channelId?: string | null): unknown
  /** Check whether a channel ID is allowed by `sessionPricing.channels` (if configured). */
  isChannelAllowed(channelId: string): boolean
  /** Handle a DELETE channel-close request; returns the HTTP response. */
  handleDelete(c: DeleteContext): Promise<Response>
  /** Arm the connection-closed orphan guard (idempotent). */
  armAbortGuard(c: SignalContext, channelId?: string | null): void
}

/** The last verified voucher: amount, its signature, and the payer it named. */
interface VerifiedVoucherRecord {
  amount: bigint
  signature: string
  payer: string | null
}

/** Per-channel session state slot managed by `createMppSessionHandlerState`. */
interface ChannelSessionSlot {
  channelId: string
  voucherRecordKey: string
  cumulativeKey: string
  record: VerifiedVoucherRecord | null
  voucherCount: number
  sessionOpened: boolean
  orphanFlagged: boolean
  idleTimer: ReturnType<typeof setTimeout> | null
  settledCleanly: boolean
  abortListenerArmed: boolean
  clearIdleTimer(): void
  armIdleTimer(): void
  loadPersistedRecord(): Promise<VerifiedVoucherRecord | null>
  readStoredCumulative(): Promise<bigint | null>
  flagOrphan(reason: 'connection-closed' | 'idle-timeout'): Promise<void>
}

function createMppSessionHandlerState(
  opts: RouteDockHonoOptions,
  sessionPricing: { rate: string; channelFactory: string; channels?: string[] },
  reportMode: 'mpp-session' | 'mpp-session-ws',
): MppSessionHandlerState {
  const networkId = CAIP2[opts.network] as 'stellar:testnet' | 'stellar:pubnet'
  const payeeKeypair = Keypair.fromSecret(opts.payeeSecretKey)
  const logger = resolveLogger(opts.logger)
  const defaultChannel = sessionPricing.channelFactory
  const allowedChannels =
    Array.isArray(sessionPricing.channels) && sessionPricing.channels.length > 0
      ? new Set<string>([defaultChannel, ...sessionPricing.channels])
      : null

  const innerStore = opts.sessionStore ?? Store.memory()
  const slots = new Map<string, ChannelSessionSlot>()
  let lastActiveChannelId = defaultChannel

  function createSlot(channelId: string): ChannelSessionSlot {
    const voucherRecordKey = `routedock:session:voucher:${channelId}`
    const cumulativeKey = `stellar:channel:cumulative:${channelId}`

    const slot: ChannelSessionSlot = {
      channelId,
      voucherRecordKey,
      cumulativeKey,
      record: null,
      voucherCount: 0,
      sessionOpened: false,
      orphanFlagged: false,
      idleTimer: null,
      settledCleanly: false,
      abortListenerArmed: false,

      clearIdleTimer(): void {
        if (slot.idleTimer) {
          clearTimeout(slot.idleTimer)
          slot.idleTimer = null
        }
      },

      armIdleTimer(): void {
        if (!opts.idleTimeoutMs) return
        slot.clearIdleTimer()
        slot.idleTimer = setTimeout(() => {
          void slot.flagOrphan('idle-timeout')
        }, opts.idleTimeoutMs)
        const maybeUnref = slot.idleTimer as unknown as { unref?: () => void }
        if (typeof maybeUnref.unref === 'function') maybeUnref.unref()
      },

      async loadPersistedRecord(): Promise<VerifiedVoucherRecord | null> {
        if (slot.record) return slot.record
        try {
          const stored = (await innerStore.get(voucherRecordKey)) as
            | {
                amount?: string
                signature?: string
                payer?: string | null
                voucherCount?: number
                sessionOpened?: boolean
              }
            | undefined
          if (!stored || typeof stored.amount !== 'string' || typeof stored.signature !== 'string') {
            return null
          }
          slot.record = {
            amount: BigInt(stored.amount),
            signature: stored.signature,
            payer: stored.payer ?? null,
          }
          if (typeof stored.voucherCount === 'number') {
            slot.voucherCount = stored.voucherCount
          }
          if (typeof stored.sessionOpened === 'boolean') {
            slot.sessionOpened = stored.sessionOpened
          } else if (slot.record !== null) {
            slot.sessionOpened = true
          }
        } catch {
          return null
        }
        return slot.record
      },

      async readStoredCumulative(): Promise<bigint | null> {
        try {
          const raw = (await innerStore.get(cumulativeKey)) as { amount?: unknown } | null | undefined
          const amount = typeof raw === 'object' && raw !== null ? raw.amount : undefined
          return typeof amount === 'string' && /^\d+$/.test(amount) ? BigInt(amount) : null
        } catch {
          return null
        }
      },

      async flagOrphan(reason: 'connection-closed' | 'idle-timeout'): Promise<void> {
        await slot.loadPersistedRecord()
        if (!slot.sessionOpened || slot.settledCleanly || slot.orphanFlagged) return
        slot.orphanFlagged = true
        slot.abortListenerArmed = false
        slot.clearIdleTimer()

        const cumulativeAmount = slot.record
          ? (Number(slot.record.amount) / 1e7).toFixed(7)
          : '0.0000000'
        if (opts.onOrphaned) {
          try {
            await opts.onOrphaned(channelId, {
              cumulativeAmount,
              lastSignature: slot.record?.signature ?? '',
              voucherCount: slot.voucherCount,
              reason,
            })
          } catch (err) {
            logger('error', '[mpp-session] onOrphaned handler failed', { error: err })
          }
        }
      },
    }

    return slot
  }

  function getSlot(channelId: string): ChannelSessionSlot {
    let slot = slots.get(channelId)
    if (!slot) {
      slot = createSlot(channelId)
      slots.set(channelId, slot)
    }
    return slot
  }

  // Ensure default channel slot exists immediately.
  getSlot(defaultChannel)

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
  // the verified amount/signature/payer as the new record for the credential's
  // channel (`routedock:session:voucher:<channelId>`), then runs the per-channel
  // bookkeeping (voucher count, idle timer, onSessionOpen/onVoucher).
  async function commit(credential: ChannelVerifyCredential, fallbackChannel = defaultChannel): Promise<void> {
    const channelId = resolveCredentialChannel(credential, fallbackChannel)
    if (allowedChannels && !allowedChannels.has(channelId)) return
    lastActiveChannelId = channelId
    const slot = getSlot(channelId)
    await slot.loadPersistedRecord()

    const payload = credential.payload
    if (typeof payload?.amount !== 'string' || typeof payload.signature !== 'string') return
    let amount: bigint
    try {
      amount = BigInt(payload.amount)
    } catch {
      return
    }
    // A late/duplicate commit can't roll the signature back to an earlier amount.
    if (slot.record && amount < slot.record.amount) return

    const payer = slot.record?.payer ?? extractPayerAddress(credential.source)
    slot.record = { amount, signature: payload.signature, payer }

    slot.voucherCount++
    // Voucher activity — this session is alive again.
    slot.settledCleanly = false
    slot.orphanFlagged = false
    slot.armIdleTimer()

    const wasOpened = slot.sessionOpened
    slot.sessionOpened = true

    await innerStore.put(slot.voucherRecordKey, {
      amount: slot.record.amount.toString(),
      signature: slot.record.signature,
      payer: slot.record.payer,
      voucherCount: slot.voucherCount,
      sessionOpened: true,
    })

    if (!wasOpened) {
      if (opts.onSessionOpen) {
        const openedPayer = slot.record.payer
        Promise.resolve()
          .then(() => opts.onSessionOpen!(channelId, openedPayer))
          .catch((err) => {
            logger('error', '[mpp-session] onSessionOpen callback error', { error: err })
            opts.onCallbackError?.(err, 'onSessionOpen')
          })
      }
    }

    if (opts.onVoucher) {
      const humanAmount = (Number(slot.record.amount) / 1e7).toFixed(7)
      const currentCount = slot.voucherCount
      const currentSig = slot.record.signature
      Promise.resolve().then(() => opts.onVoucher!(channelId, currentCount, humanAmount, currentSig)).catch(err => {
        logger('error', '[mpp-session] onVoucher callback error', { error: err })
        opts.onCallbackError?.(err, 'onVoucher')
      })
    }
  }

  function createMppxForChannel(channelId: string): unknown {
    return Mppx.create({
      secretKey: opts.payeeSecretKey,
      methods: [
        withTypedChannelErrors(
          onVerifiedCredential(
            mppChannel({
              channel: channelId,
              commitmentKey: opts.commitmentPublicKey!,
              network: networkId,
              store: wrappedStore,
              sourceAccount: payeeKeypair.publicKey(),
              feePayer: channelAuthorizer(payeeKeypair),
            }) as Method.AnyServer,
            channelId === defaultChannel
              ? commit
              : (cred) => commit(cred, channelId),
          ),
        ),
      ],
    })
  }

  const mppxByChannel = new Map<string, unknown>()
  const mppx = createMppxForChannel(defaultChannel)
  mppxByChannel.set(defaultChannel, mppx)

  function getMppx(channelId?: string | null): unknown {
    const resolved = channelId && channelId.length > 0 ? channelId : defaultChannel
    let instance = mppxByChannel.get(resolved)
    if (!instance) {
      instance = createMppxForChannel(resolved)
      mppxByChannel.set(resolved, instance)
    }
    return instance
  }

  return {
    mppx,
    getMppx,
    isChannelAllowed(channelId: string): boolean {
      return !allowedChannels || allowedChannels.has(channelId)
    },

    async handleDelete(c: DeleteContext): Promise<Response> {
      let body: {
        amount?: string
        signature?: string
        channel?: string
        channelId?: string
      } | undefined
      try {
        body = (await c.req.json()) as {
          amount?: string
          signature?: string
          channel?: string
          channelId?: string
        }
      } catch {
        // empty or non-JSON body
      }

      const bodyChannel =
        typeof body?.channel === 'string' && body.channel.trim().length > 0
          ? body.channel.trim()
          : typeof body?.channelId === 'string' && body.channelId.trim().length > 0
            ? body.channelId.trim()
            : null
      const headerChannel = extractRequestChannel(
        typeof c.req.header === 'function' ? (name) => c.req.header!(name) : undefined,
      )
      const targetChannelId = bodyChannel ?? headerChannel ?? defaultChannel
      if (allowedChannels && !allowedChannels.has(targetChannelId)) {
        return c.json({ closeTxHash: null, error: 'channel not allowed' }, 403)
      }

      const slot = getSlot(targetChannelId)
      await slot.loadPersistedRecord()

      const bodyAmount = body?.amount ? BigInt(body.amount) : 0n
      const recordAmount = slot.record?.amount ?? 0n
      let closeAmount: bigint
      let closeSig: string
      if (bodyAmount > recordAmount) {
        closeAmount = bodyAmount
        closeSig = body?.signature ?? slot.record?.signature ?? ''
      } else {
        closeAmount = recordAmount
        // Prefer the provider's own verified-voucher signature. Fall back to
        // the client's only when it signs the same amount and the provider
        // never verified one — otherwise a close for a genuinely tracked
        // amount no-ops and the session is never flagged for recovery.
        closeSig =
          slot.record?.signature ||
          (bodyAmount === recordAmount ? body?.signature ?? '' : '')
      }

      if (closeAmount > 0n && closeSig) {
        // Floor: a DELETE close must never broadcast below the highest voucher
        // mppx verified for this channel.
        const storedCumulative = await slot.readStoredCumulative()
        if (storedCumulative !== null && closeAmount < storedCumulative) {
          return c.json(
            {
              closeTxHash: null,
              error: 'close amount below the highest verified voucher',
            },
            409,
          )
        }

        const closeTxHash = await channelClose({
          channel: targetChannelId,
          amount: closeAmount,
          signature: hexToBytes(closeSig),
          feePayer: channelAuthorizer(payeeKeypair),
          network: networkId,
        })

        // Clean close — suppress any orphan flagging for this channel only.
        slot.settledCleanly = true
        slot.clearIdleTimer()

        const closePayer = slot.record?.payer ?? null
        const settledVoucherCount = slot.voucherCount

        if (opts.onSettled) {
          const totalPaid = (Number(closeAmount) / 1e7).toFixed(7)
          Promise.resolve().then(() => opts.onSettled!(closeTxHash, totalPaid, reportMode, closePayer, targetChannelId)).catch(err => {
            logger('error', '[mpp-session] onSettled callback error', { error: err })
            opts.onCallbackError?.(err, 'onSettled')
          })
        }

        const vaultConfig = resolveVaultSettlementConfig(opts.vaultSettlement, logger)
        if (vaultConfig) {
          const settlement = recordSessionSettlement(
            {
              config: vaultConfig,
              network: opts.network,
              payeeSecretKey: opts.payeeSecretKey,
              channelId: targetChannelId,
              payer: closePayer,
              amount: closeAmount,
              voucherCount: settledVoucherCount,
            },
            { logger, onCallbackError: opts.onCallbackError },
          )
          if (opts.waitUntil) opts.waitUntil(settlement)
          else void settlement
        }

        slot.sessionOpened = false
        slot.voucherCount = 0
        slot.orphanFlagged = false
        slot.record = null
        await innerStore.delete(slot.voucherRecordKey)
        slot.abortListenerArmed = false

        return c.json({ closeTxHash })
      }

      return c.json({ closeTxHash: null, message: 'no vouchers received' })
    },

    armAbortGuard(c: SignalContext, channelId?: string | null): void {
      const targetChannelId = channelId || lastActiveChannelId || defaultChannel
      const slot = getSlot(targetChannelId)
      const signal = c.req.raw.signal
      if (signal && !slot.abortListenerArmed) {
        slot.abortListenerArmed = true
        signal.addEventListener(
          'abort',
          () => { void slot.flagOrphan('connection-closed') },
          { once: true },
        )
      }
    },
  }
}

function createMppSessionHonoHandler(
  opts: RouteDockHonoOptions,
  config: { mode: 'mpp-session' | 'mpp-session-ws' },
  state: MppSessionHandlerState,
): MiddlewareHandler {
  const sessionPricing = opts.pricing[config.mode]!
  const logger = resolveLogger(opts.logger)
  return async (c, next) => {
    try {
      if (c.req.method === 'DELETE') {
        // `await` so a rejected close is caught below rather than escaping.
        return await state.handleDelete(c as unknown as DeleteContext)
      }

      const requestChannelId = extractRequestChannel((name) => c.req.header(name))
      if (requestChannelId && !state.isChannelAllowed(requestChannelId)) {
        return c.json({ error: 'Channel not allowed' }, 403)
      }
      const mppxInstance = state.getMppx(requestChannelId)

      const result = await (
        mppxInstance as unknown as {
          channel: (o: { amount: string; description?: string }) => (
            r: globalThis.Request,
          ) => Promise<{
            status: number
            challenge?: globalThis.Response
            withReceipt?: (r: globalThis.Response) => globalThis.Response
          }>
        }
      ).channel({
        amount: sessionPricing.rate,
        description: opts.manifest.name,
      })(c.req.raw)

      if (result.status === 402) {
        const challenge = result.challenge!
        const headers: Record<string, string> = {}
        challenge.headers.forEach((v: string, k: string) => { headers[k] = v })
        return new Response(await challenge.text(), { status: 402, headers })
      }

      state.armAbortGuard(c as unknown as SignalContext, requestChannelId)

      // mpp-session-ws: the verified request is a WebSocket handshake, so hand
      // control to the app's upgrade route (it checks MPP_SESSION_WS_VERIFIED)
      // instead of letting the data route answer with a 200 body.
      if (config.mode === 'mpp-session-ws' && isWebSocketUpgradeRequest(c)) {
        c.set(MPP_SESSION_WS_VERIFIED, true)
        await next()
        return
      }

      await next()
    } catch (err) {
      if (err instanceof RouteDockManifestError) {
        throw err
      }
      logger('error', `[${config.mode}] Session error`, { error: err })
      return c.json({ error: 'Session payment failed' }, 500)
    }
  }
}

/** True when the request is a WebSocket upgrade handshake. */
function isWebSocketUpgradeRequest(c: {
  req: { header: (name: string) => string | undefined }
}): boolean {
  return (c.req.header('upgrade') ?? '').toLowerCase() === 'websocket'
}

/**
 * Hono middleware factory for RouteDock provider endpoints.
 *
 * **Workers-safe entry point.** This module uses only Web-standard APIs
 * (`atob`/`TextDecoder` via {@link base64ToUtf8}, {@link hexToBytes}, and the
 * request `AbortSignal`) and runs on Cloudflare Workers, Bun, Deno Deploy, and
 * any Hono deployment target. The Express `routedock()` middleware
 * (`@routedock/routedock/provider`) is Node.js-only — it relies on Node's
 * `Buffer` and `req.on('close')`.
 *
 * Exposes the same configuration surface as the Express `routedock()` middleware.
 *
 * @example
 * ```ts
 * import { routedockHono } from '@routedock/routedock/provider/hono'
 *
 * app.use('/price', routedockHono({
 *   modes: ['x402', 'mpp-charge'],
 *   pricing: { x402: '0.001', 'mpp-charge': '0.0008' },
 *   ...
 * }))
 * ```
 */
export function routedockHono(opts: RouteDockHonoOptions): MiddlewareHandler {
  const handlers: MiddlewareHandler[] = []
  assertProviderConfig(opts, 'routedockHono')
  const signedManifest = signManifest(opts.manifest, opts.payeeSecretKey)

  if (opts.modes.includes('x402') && opts.pricing.x402) {
    handlers.push(createX402HonoHandler({ ...opts, manifest: signedManifest }))
  }

  if (opts.modes.includes('mpp-charge') && opts.pricing['mpp-charge']) {
    handlers.push(createMppChargeHonoHandler({ ...opts, manifest: signedManifest }))
  }

  // Session modes (mpp-session, mpp-session-ws) share one channel store so a
  // provider advertising both transports verifies vouchers against the same
  // cumulative state and a DELETE close sees the combined total.
  const sessionModes = (['mpp-session', 'mpp-session-ws'] as const).filter(
    (mode) => opts.modes.includes(mode) && !!opts.pricing[mode],
  )
  const primarySessionMode = sessionModes[0]
  if (primarySessionMode) {
    if (!opts.commitmentPublicKey) {
      throw new Error('routedockHono: mpp-session/mpp-session-ws mode requires commitmentPublicKey')
    }
    const sessionPricing = opts.pricing[primarySessionMode]!
    const sharedState = createMppSessionHandlerState(opts, sessionPricing, primarySessionMode)
    for (const mode of sessionModes) {
      handlers.push(
        createMppSessionHonoHandler({ ...opts, manifest: signedManifest }, { mode }, sharedState),
      )
    }
  }

  return async (c, next) => {
    if (c.req.path === '/.well-known/routedock.json') {
      return c.json(signedManifest)
    }

    if (handlers.length === 0) {
      await next()
      return
    }

    const hasX402Header = !!(
      c.req.header('payment-signature') || c.req.header('x-payment')
    )
    const prefersX402 = c.req.header('x-preferred-mode') === 'x402'

    const handler =
      hasX402Header || prefersX402 ? handlers[0] : handlers[handlers.length - 1]

    if (!handler) {
      await next()
      return
    }

    return handler(c, next)
  }
}

export { registerProvider, type RegisterProviderOptions } from './registerProvider.js'
export { signManifest } from '../manifest/sign.js'
export type { VaultSettlementConfig } from '../internal/vaultConfig.js'
export {
  SupabaseSeenTxStore,
} from '../store/SupabaseSeenTxStore.js'
export {
  InMemorySeenTxStore,
  type SeenTxStore,
  type SettlementRecord,
} from './SeenTxStore.js'
export {
  reconcileAbandonedSessions,
  runStartupReconciliation,
  type SessionReconcilerOptions,
  type ReconciliationStats,
} from './SessionReconciler.js'
