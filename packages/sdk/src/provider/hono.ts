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
    'mpp-session'?: { rate: string; channelContract: string }
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
}

function createX402HonoHandler(opts: RouteDockHonoOptions): MiddlewareHandler {
  const caip2 = CAIP2[opts.network]
  const payeeKeypair = Keypair.fromSecret(opts.payeeSecretKey)
  const signer = createEd25519Signer(opts.payeeSecretKey, caip2)
  const x402Price = opts.pricing.x402!

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

      const payload = decodePaymentSignatureHeader(paymentHeader)
      let txHash: string | null = null
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
          c.header(
            'X-Payment-Response',
            encodePaymentResponseHeader(
              settleResult as Parameters<typeof encodePaymentResponseHeader>[0],
            ),
          )
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
          c.header(
            'X-Payment-Response',
            encodePaymentResponseHeader(
              settleResult as Parameters<typeof encodePaymentResponseHeader>[0],
            ),
          )
        }
      }

      if (txHash && opts.onSettled) {
        await opts.onSettled(txHash, x402Price, 'x402', payerAddress)
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
        // non-fatal
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
      receipt.headers.forEach((v: string, k: string) => c.header(k, v))

      const receiptHeader = receipt.headers.get('payment-receipt')
      if (receiptHeader && opts.onSettled) {
        try {
          const parsed = JSON.parse(
            Buffer.from(receiptHeader, 'base64').toString('utf8'),
          ) as { reference?: string }
          if (parsed.reference) {
            await opts.onSettled(parsed.reference, chargePrice, 'mpp-charge', payerAddress)
          }
        } catch {
          // non-fatal
        }
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
  const cumulativeKey = `stellar:channel:cumulative:${sessionPricing.channelContract}`

  const innerStore = Store.memory()
  let lastCumulativeAmount = 0n
  let voucherCount = 0
  let sessionOpened = false
  let lastSignatureHex = ''
  let sessionPayerAddress: string | null = null

  const wrappedStore: ReturnType<typeof Store.memory> = {
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

        if (!sessionOpened) {
          sessionOpened = true
          if (opts.onSessionOpen) {
            await opts.onSessionOpen(sessionPricing.channelContract, sessionPayerAddress)
          }
        }

        if (opts.onVoucher) {
          const humanAmount = (Number(lastCumulativeAmount) / 1e7).toFixed(7)
          await opts.onVoucher(voucherCount, humanAmount)
        }
      }
    },
    async delete(key: string) { return innerStore.delete(key) },
  }

  const mppx = Mppx.create({
    secretKey: opts.payeeSecretKey,
    methods: [
      mppChannel({
        channel: sessionPricing.channelContract,
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
          const closeTxHash = await channelClose({
            channel: sessionPricing.channelContract,
            amount: closeAmount,
            signature: Buffer.from(closeSig, 'hex'),
            feePayer: { envelopeSigner: payeeKeypair },
            network: networkId,
          })

          if (opts.onSettled) {
            const totalPaid = (Number(lastCumulativeAmount) / 1e7).toFixed(7)
            await opts.onSettled(closeTxHash, totalPaid, 'mpp-session', sessionPayerAddress)
          }

          sessionOpened = false
          voucherCount = 0
          lastCumulativeAmount = 0n
          sessionPayerAddress = null

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
            const credJson = Buffer.from(
              credB64.split('=').slice(1).join('=').replace(/^"|"$/g, ''),
              'base64',
            ).toString('utf8')
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

      await next()
    } catch (err) {
      throw err
    }
  }
}

/**
 * Hono middleware factory for RouteDock provider endpoints.
 *
 * Compatible with Cloudflare Workers, Bun, Deno Deploy, and any Hono deployment target.
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
