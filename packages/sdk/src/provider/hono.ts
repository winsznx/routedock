import type { Context, MiddlewareHandler, Next } from 'hono'
import { Keypair } from '@stellar/stellar-sdk'
import { Mppx as MppxHono } from 'mppx/hono'
import { stellar as chargeStellar } from '@stellar/mpp/charge/server'
import { stellar as channelStellar, close as channelClose, Store } from '@stellar/mpp/channel/server'
import { createX402Core } from './x402Core.js'
import type { RouteDockMiddlewareOptions } from './routedockMiddleware.js'

type Network = 'testnet' | 'mainnet'

const MPP_NETWORK: Record<Network, 'stellar:testnet' | 'stellar:pubnet'> = {
  testnet: 'stellar:testnet',
  mainnet: 'stellar:pubnet',
}

/**
 * Configuration for the Hono provider adapter.
 *
 * Identical to the Express {@link RouteDockMiddlewareOptions}, plus an optional
 * pluggable `store` for mpp-session voucher state. On edge runtimes the
 * in-memory default does not survive between isolate invocations, so supply a
 * durable store (e.g. `Store.cloudflare(env.KV)`) for multi-request sessions.
 */
export interface RouteDockHonoOptions extends RouteDockMiddlewareOptions {
  /** Persistent voucher store for mpp-session. Defaults to in-memory. */
  store?: Store.Store
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(Math.floor(hex.length / 2))
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

function decodeBase64Utf8(b64: string): string {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new TextDecoder().decode(bytes)
}

function createHonoX402Handler(opts: RouteDockHonoOptions, amount: string): MiddlewareHandler {
  const core = createX402Core({
    payeeSecretKey: opts.payeeSecretKey,
    network: opts.network,
    amount,
    assetContract: opts.assetContract,
    ...(opts.facilitatorApiKey ? { facilitatorApiKey: opts.facilitatorApiKey } : {}),
    manifest: opts.manifest,
    ...(opts.onSettled ? { onSettled: opts.onSettled } : {}),
  })

  return async (c: Context, next: Next): Promise<Response | void> => {
    const paymentHeader = c.req.header('payment-signature') ?? c.req.header('x-payment')
    const outcome = await core.handle({ paymentHeader, resourceUrl: c.req.url })

    switch (outcome.kind) {
      case 'payment-required':
        for (const [key, value] of Object.entries(outcome.headers)) c.header(key, value)
        return c.json(outcome.body as object, outcome.status)
      case 'verification-failed':
        return c.json(outcome.body as object, outcome.status)
      case 'error':
        return c.json(outcome.body as object, outcome.status)
      case 'settled': {
        await next()
        const entries = Object.entries(outcome.headers)
        if (entries.length > 0) {
          const headers = new Headers(c.res.headers)
          for (const [key, value] of entries) headers.set(key, value)
          c.res = new Response(c.res.body, { status: c.res.status, headers })
        }
        return
      }
    }
  }
}

type ChargeRequestOptions = {
  amount: string
  currency: string
  recipient: string
  description?: string
}

function createHonoChargeHandler(opts: RouteDockHonoOptions, amount: string): MiddlewareHandler {
  const networkId = MPP_NETWORK[opts.network]

  const mppx = MppxHono.create({
    secretKey: opts.payeeSecretKey,
    methods: [
      chargeStellar.charge({
        recipient: opts.manifest.payee,
        currency: opts.assetContract,
        network: networkId,
        feePayer: { envelopeSigner: opts.payeeSecretKey },
      }),
    ],
  })

  const charge = (mppx as unknown as {
    'stellar/charge': (o: ChargeRequestOptions) => MiddlewareHandler
  })['stellar/charge']

  return charge({
    amount,
    currency: opts.assetContract,
    recipient: opts.manifest.payee,
    description: opts.manifest.name,
  })
}

type SessionPricing = { rate: string; channelContract: string }

function createHonoSessionHandler(opts: RouteDockHonoOptions, pricing: SessionPricing): MiddlewareHandler {
  const networkId = MPP_NETWORK[opts.network]
  const payeeKeypair = Keypair.fromSecret(opts.payeeSecretKey)
  const channelContract = pricing.channelContract
  const cumulativeKey = `stellar:channel:cumulative:${channelContract}`
  const baseStore = opts.store ?? Store.memory()

  let lastCumulativeAmount = 0n
  let voucherCount = 0
  let sessionOpened = false

  const wrappedStore: Store.Store = {
    async get(key: string) {
      return baseStore.get(key)
    },
    async put(key: string, value: unknown) {
      await baseStore.put(key, value)
      if (key === cumulativeKey && value && typeof value === 'object' && 'amount' in (value as Record<string, unknown>)) {
        lastCumulativeAmount = BigInt((value as { amount: string }).amount)
        voucherCount++

        if (!sessionOpened) {
          sessionOpened = true
          if (opts.onSessionOpen) await opts.onSessionOpen(channelContract)
        }

        if (opts.onVoucher) {
          const humanAmount = (Number(lastCumulativeAmount) / 1e7).toFixed(7)
          await opts.onVoucher(voucherCount, humanAmount)
        }
      }
    },
    async delete(key: string) {
      return baseStore.delete(key)
    },
  }

  const mppx = MppxHono.create({
    secretKey: opts.payeeSecretKey,
    methods: [
      channelStellar.channel({
        channel: channelContract,
        commitmentKey: opts.commitmentPublicKey!,
        network: networkId,
        store: wrappedStore,
        sourceAccount: payeeKeypair.publicKey(),
        feePayer: { envelopeSigner: payeeKeypair },
      }),
    ],
  })

  const channel = (mppx as unknown as {
    'stellar/channel': (o: { amount: string; description?: string }) => MiddlewareHandler
  })['stellar/channel']

  const channelHandler = channel({
    amount: pricing.rate,
    description: opts.manifest.name,
  })

  let lastSignatureHex = ''

  return async (c: Context, next: Next): Promise<Response | void> => {
    if (c.req.method === 'DELETE') {
      const body = (await c.req.json().catch(() => ({}))) as { amount?: string; signature?: string }
      const closeAmount = body?.amount ? BigInt(body.amount) : lastCumulativeAmount
      const closeSig = body?.signature ?? lastSignatureHex

      try {
        if (closeAmount > 0n && closeSig) {
          const closeTxHash = await channelClose({
            channel: channelContract,
            amount: closeAmount,
            signature: hexToBytes(closeSig),
            feePayer: { envelopeSigner: payeeKeypair },
            network: networkId,
          })

          if (opts.onSettled) {
            const totalPaid = (Number(lastCumulativeAmount) / 1e7).toFixed(7)
            await opts.onSettled(closeTxHash, totalPaid, 'mpp-session')
          }

          return c.json({ closeTxHash })
        }

        return c.json({ closeTxHash: null, message: 'no vouchers received' })
      } finally {
        sessionOpened = false
        voucherCount = 0
        lastCumulativeAmount = 0n
      }
    }

    const authHeader = c.req.header('authorization')
    if (typeof authHeader === 'string' && authHeader.startsWith('Payment ')) {
      try {
        const credEntry = authHeader
          .replace(/^Payment\s+/, '')
          .split(',')
          .find((p) => p.trim().startsWith('credential='))
        if (credEntry) {
          const raw = credEntry.split('=').slice(1).join('=').replace(/^"|"$/g, '')
          const cred = JSON.parse(decodeBase64Utf8(raw)) as { payload?: { signature?: string } }
          if (cred.payload?.signature) lastSignatureHex = cred.payload.signature
        }
      } catch {
        // best-effort — signature is also accepted in the DELETE body
      }
    }

    return channelHandler(c, next)
  }
}

/**
 * Hono adapter for RouteDock provider endpoints — the edge-runtime counterpart
 * to the Express {@link routedock} middleware (Cloudflare Workers, Bun, Deno).
 *
 * Serves `/.well-known/routedock.json` and enforces payment verification for
 * all three modes (x402, mpp-charge, mpp-session) using the identical config.
 *
 * @example
 * ```ts
 * import { Hono } from 'hono'
 * import { routedockHono } from '@routedock/routedock/provider/hono'
 *
 * const app = new Hono()
 * app.use('/price', routedockHono({
 *   modes: ['x402', 'mpp-charge'],
 *   pricing: { x402: '0.001', 'mpp-charge': '0.0008' },
 *   ...
 * }))
 * app.get('/price', (c) => c.json({ price: '1.2345' }))
 * ```
 */
export function routedockHono(opts: RouteDockHonoOptions): MiddlewareHandler {
  const handlers: MiddlewareHandler[] = []

  if (opts.modes.includes('x402') && opts.pricing.x402) {
    handlers.push(createHonoX402Handler(opts, opts.pricing.x402))
  }

  if (opts.modes.includes('mpp-charge') && opts.pricing['mpp-charge']) {
    handlers.push(createHonoChargeHandler(opts, opts.pricing['mpp-charge']))
  }

  if (opts.modes.includes('mpp-session') && opts.pricing['mpp-session']) {
    if (!opts.commitmentPublicKey) {
      throw new Error('routedockHono: mpp-session mode requires commitmentPublicKey')
    }
    handlers.push(createHonoSessionHandler(opts, opts.pricing['mpp-session']))
  }

  return async (c: Context, next: Next): Promise<Response | void> => {
    if (c.req.path === '/.well-known/routedock.json') {
      return c.json(opts.manifest)
    }

    if (handlers.length === 0) return next()

    const hasX402Header = !!(c.req.header('payment-signature') || c.req.header('x-payment'))
    const prefersX402 = c.req.header('x-preferred-mode') === 'x402'

    const handler = hasX402Header || prefersX402 ? handlers[0] : handlers[handlers.length - 1]
    if (!handler) return next()

    return handler(c, next)
  }
}
