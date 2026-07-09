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
import { resolvePayee } from './payee.js'
import type { OrphanedSessionInfo } from './MppSessionHandler.js'
import { base64ToUtf8, hexToBytes } from './encoding.js'
import {
  InMemorySeenTxStore,
  paymentIdempotencyKey,
  type SeenTxStore,
} from './SeenTxStore.js'

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
    'mpp-session'?: { rate: string; channelFactory: string }
  }
  asset: string
  assetContract: string
  payee: string
  network: Network
  payeeSecretKey: string
  facilitatorApiKey?: string
  commitmentPublicKey?: string
  manifest: RouteDockManifest
  onSettled?: (txHash: string, amount: string, mode: string, payer: string | null) => Promise<void>
  onSessionOpen?: (channelId: string, payer: string | null) => Promise<void>
  onVoucher?: (voucherIndex: number, cumulativeAmount: string) => Promise<void>
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
}

function createX402HonoHandler(opts: RouteDockHonoOptions): MiddlewareHandler {
  const caip2 = CAIP2[opts.network]
  const payeeKeypair = Keypair.fromSecret(opts.payeeSecretKey)
  const signer = createEd25519Signer(opts.payeeSecretKey, caip2)
  const x402Price = opts.pricing.x402!
  const seenTxStore = opts.seenTxStore ?? new InMemorySeenTxStore()

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

  const amountInBaseUnits = String(Math.round(parseFloat(x402Price) * 1e7))
  const requirements = {
    scheme: 'exact' as const,
    network: caip2,
    asset: opts.assetContract,
    amount: amountInBaseUnits,
    payTo: resolvePayee(opts.manifest, 'x402'),
    maxTimeoutSeconds: 60,
    extra: {
      areFeesSponsored: true,
      ...(useOzFacilitator ? {} : { facilitatorAddresses: [payeeKeypair.publicKey()] }),
    },
  }

  return async (c, next) => {
    try {
      const paymentHeader = c.req.header('payment-signature') ?? c.req.header('x-payment')

      if (!paymentHeader) {
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
          return c.json({ error: 'Payment Required' }, 402)
        } else {
          const x402Response = {
            x402Version: 2,
            resource: { url: c.req.url, description: opts.manifest.name },
            accepts: [requirements],
          }
          c.header('X-Payment-Requirements', encodePaymentRequiredHeader(x402Response))
          return c.json({ error: 'Payment Required' }, 402)
        }
      }

      // Idempotency: a retry of an already-settled payment replays the cached
      // settlement response instead of settling (and billing) a second time.
      const idempotencyKey = paymentIdempotencyKey((name) => c.req.header(name))
      if (idempotencyKey) {
        const cached = await seenTxStore.get(idempotencyKey)
        if (cached) {
          if (cached.headers) {
            for (const [k, val] of Object.entries(cached.headers)) {
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
        if (typeof key === 'string' && key.startsWith('G')) {
          payerAddress = key
        }
      } catch {
        // non-fatal
      }

      if (ozServer) {
        const settleResult = await ozServer.settlePayment(payload, requirements)
        txHash = (settleResult as { transaction?: string }).transaction ?? null
        if (settleResult) {
          paymentResponseHeader = encodePaymentResponseHeader(
            settleResult as Parameters<typeof encodePaymentResponseHeader>[0],
          )
          c.header('X-Payment-Response', paymentResponseHeader)
        }
      } else {
        const verifyResult = await localFacilitator.verify(
          payload as Parameters<typeof localFacilitator.verify>[0],
          requirements,
        )
        if (!verifyResult.isValid) {
          return c.json(
            {
              error: 'Payment verification failed',
              reason: (verifyResult as { invalidReason?: string }).invalidReason,
            },
            401,
          )
        }
        const settleResult = await localFacilitator.settle(
          payload as Parameters<typeof localFacilitator.settle>[0],
          requirements,
        )
        txHash = (settleResult as { transaction?: string }).transaction ?? null
        if (settleResult) {
          paymentResponseHeader = encodePaymentResponseHeader(
            settleResult as Parameters<typeof encodePaymentResponseHeader>[0],
          )
          c.header('X-Payment-Response', paymentResponseHeader)
        }
      }

      // Record the settlement so a retry of this exact payment is deduped.
      if (idempotencyKey) {
        const headers: Record<string, string> = {}
        if (paymentResponseHeader) headers['X-Payment-Response'] = paymentResponseHeader
        await seenTxStore.set(idempotencyKey, { txHash, headers })
      }

      if (txHash && opts.onSettled) {
        Promise.resolve().then(() => opts.onSettled!(txHash!, x402Price, 'x402', payerAddress)).catch(err => {
          console.error('[x402] onSettled callback error:', err)
          opts.onCallbackError?.(err, 'onSettled')
        })
      }

      await next()
    } catch (err) {
      console.error('[x402] Settlement error:', err)
      return c.json({ error: 'Payment settlement failed' }, 500)
    }
  }
}

function createMppChargeHonoHandler(opts: RouteDockHonoOptions): MiddlewareHandler {
  const networkId = CAIP2[opts.network] as 'stellar:testnet' | 'stellar:pubnet'
  const chargePrice = opts.pricing['mpp-charge']!
  const recipient = resolvePayee(opts.manifest, 'mpp-charge')
  const seenTxStore = opts.seenTxStore ?? new InMemorySeenTxStore()

  const mppx = Mppx.create({
    secretKey: opts.payeeSecretKey,
    methods: [
      mppCharge({
        recipient,
        currency: opts.assetContract,
        network: networkId,
        feePayer: { envelopeSigner: opts.payeeSecretKey },
      }),
    ],
  })

  return async (c, next) => {
    try {
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
            if (typeof key === 'string' && key.startsWith('G')) {
              payerAddress = key
            }
          }
        }
      } catch {
        // non-fatal
      }

      // Idempotency: a retry of an already-settled charge replays the cached
      // receipt headers instead of settling (and billing) a second time.
      const idempotencyKey = paymentIdempotencyKey((name) => c.req.header(name))
      if (idempotencyKey) {
        const cached = await seenTxStore.get(idempotencyKey)
        if (cached) {
          if (cached.headers) {
            for (const [k, val] of Object.entries(cached.headers)) {
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
        currency: opts.assetContract,
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
        await seenTxStore.set(idempotencyKey, {
          txHash: reference ?? null,
          headers: receiptHeaders,
        })
      }

      if (reference && opts.onSettled) {
        Promise.resolve().then(() => opts.onSettled!(reference!, chargePrice, 'mpp-charge', payerAddress)).catch(err => {
          console.error('[mpp-charge] onSettled callback error:', err)
          opts.onCallbackError?.(err, 'onSettled')
        })
      }

      await next()
    } catch (err) {
      throw err
    }
  }
}

function createMppSessionHonoHandler(opts: RouteDockHonoOptions): MiddlewareHandler {
  const networkId = CAIP2[opts.network] as 'stellar:testnet' | 'stellar:pubnet'
  const sessionPricing = opts.pricing['mpp-session']!
  const payeeKeypair = Keypair.fromSecret(opts.payeeSecretKey)
  const cumulativeKey = `stellar:channel:cumulative:${sessionPricing.channelFactory}`

  const innerStore = Store.memory()
  let lastCumulativeAmount = 0n
  let voucherCount = 0
  let sessionOpened = false
  let lastSignatureHex = ''
  let sessionPayerAddress: string | null = null
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let settledCleanly = false
  let abortListenerArmed = false

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
    // `unref` exists on Node's Timeout but not the Web `number` handle — call it
    // defensively so the timer never keeps a Node process alive.
    const maybeUnref = idleTimer as unknown as { unref?: () => void }
    if (typeof maybeUnref.unref === 'function') maybeUnref.unref()
  }

  // Flag an open-but-unsettled session for the reconciler. Idempotent.
  async function flagOrphan(reason: 'connection-closed' | 'idle-timeout'): Promise<void> {
    if (!sessionOpened || settledCleanly) return
    sessionOpened = false
    abortListenerArmed = false
    clearIdleTimer()

    const cumulativeAmount = (Number(lastCumulativeAmount) / 1e7).toFixed(7)
    if (opts.onOrphaned) {
      try {
        await opts.onOrphaned(sessionPricing.channelFactory, {
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
      if (
        key === cumulativeKey &&
        value &&
        typeof value === 'object' &&
        'amount' in (value as Record<string, unknown>)
      ) {
        lastCumulativeAmount = BigInt((value as { amount: string }).amount)
        voucherCount++
        // Voucher activity — this session is alive again.
        settledCleanly = false
        armIdleTimer()

        if (!sessionOpened) {
          sessionOpened = true
          if (opts.onSessionOpen) {
            Promise.resolve()
              .then(() => opts.onSessionOpen!(sessionPricing.channelFactory, sessionPayerAddress))
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
      mppChannel({
        channel: sessionPricing.channelFactory,
        commitmentKey: opts.commitmentPublicKey!,
        network: networkId,
        store: wrappedStore,
        sourceAccount: payeeKeypair.publicKey(),
        feePayer: { envelopeSigner: payeeKeypair },
      }),
    ],
  })

  return async (c, next) => {
    try {
      if (c.req.method === 'DELETE') {
        let body: { amount?: string; signature?: string } | undefined
        try {
          body = await c.req.json() as { amount?: string; signature?: string }
        } catch {
          // empty or non-JSON body
        }

        const closeAmount = body?.amount ? BigInt(body.amount) : lastCumulativeAmount
        const closeSig = body?.signature ?? lastSignatureHex

        if (closeAmount > 0n && closeSig) {
          // Clean close — suppress any orphan flagging for this session.
          settledCleanly = true
          clearIdleTimer()

          const closeTxHash = await channelClose({
            channel: sessionPricing.channelFactory,
            amount: closeAmount,
            signature: hexToBytes(closeSig),
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

          sessionOpened = false
          voucherCount = 0
          lastCumulativeAmount = 0n
          sessionPayerAddress = null
          abortListenerArmed = false

          return c.json({ closeTxHash })
        }

        return c.json({ closeTxHash: null, message: 'no vouchers received' })
      }

      const authHeader = c.req.header('authorization')
      if (authHeader?.startsWith('Payment ')) {
        try {
          const credB64 = authHeader
            .replace(/^Payment\s+/, '')
            .split(',')
            .find((p) => p.trim().startsWith('credential='))
          if (credB64) {
            const credJson = base64ToUtf8(
              credB64.split('=').slice(1).join('=').replace(/^"|"$/g, ''),
            )
            const cred = JSON.parse(credJson) as {
              sender?: string
              payload?: { signature?: string; sender?: string; from?: string }
            }
            if (cred.payload?.signature) {
              lastSignatureHex = cred.payload.signature
            }
            if (!sessionPayerAddress) {
              const key = cred.sender ?? cred.payload?.sender ?? cred.payload?.from
              if (typeof key === 'string' && key.startsWith('G')) {
                sessionPayerAddress = key
              }
            }
          }
        } catch {
          // non-fatal
        }
      }

      const result = await (
        mppx as unknown as {
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

      // Payment verified. The Workers/edge runtime exposes connection teardown
      // via the request's AbortSignal — use it (in place of Node's
      // `req.on('close')`) so a client crash mid-session flags the channel for
      // the reconciler instead of leaking state.
      const signal = c.req.raw.signal
      if (signal && !abortListenerArmed) {
        abortListenerArmed = true
        signal.addEventListener(
          'abort',
          () => { void flagOrphan('connection-closed') },
          { once: true },
        )
      }

      await next()
    } catch (err) {
      throw err
    }
  }
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
 * import { routedockHono } from '@routedock/sdk/provider/hono'
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
  const signedManifest = signManifest(opts.manifest, opts.payeeSecretKey)

  if (opts.modes.includes('x402') && opts.pricing.x402) {
    handlers.push(createX402HonoHandler({ ...opts, manifest: signedManifest }))
  }

  if (opts.modes.includes('mpp-charge') && opts.pricing['mpp-charge']) {
    handlers.push(createMppChargeHonoHandler({ ...opts, manifest: signedManifest }))
  }

  if (opts.modes.includes('mpp-session') && opts.pricing['mpp-session']) {
    if (!opts.commitmentPublicKey) {
      throw new Error('routedockHono: mpp-session mode requires commitmentPublicKey')
    }
    handlers.push(createMppSessionHonoHandler({ ...opts, manifest: signedManifest }))
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
