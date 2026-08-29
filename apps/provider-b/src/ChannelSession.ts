import { DurableObject } from 'cloudflare:workers'
import { Hono } from 'hono'
import { upgradeWebSocket } from 'hono/cloudflare-workers'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import {
  routedockHono,
  mppSessionWsVerified,
} from '@routedock/routedock/provider/hono'
import { Store } from '@stellar/mpp/channel/server'
import {
  buildManifest,
  HORIZON_URLS,
  SESSION_RATE,
  USDC_ISSUERS,
  type Network,
} from './manifest.js'
import type { Env } from './env.js'

/**
 * Mirrors the SDK's OrphanedSessionInfo. Declared locally because the type is
 * only re-exported from `@routedock/routedock/provider`, the Node-only Express
 * entry point, which must not appear in a Workers bundle.
 */
interface OrphanedSessionInfo {
  cumulativeAmount: string
  lastSignature: string
  voucherCount: number
  reason: 'connection-closed' | 'idle-timeout'
}

interface OrderBookLevel {
  price: string
  amount: string
}

interface OrderBookResponse {
  asks: OrderBookLevel[]
  bids: OrderBookLevel[]
}

/**
 * The mpp-session provider, hosted inside a single Durable Object.
 *
 * This is not an optimisation, it is a correctness requirement. The SDK's
 * session middleware keeps `lastCumulativeAmount`, `voucherCount`,
 * `lastSignatureHex` and `sessionPayerAddress` in closure scope, and the mppx
 * channel store it builds is `Store.memory()`. That was sound on Railway,
 * where one process served an entire session.
 *
 * On plain Workers it is not: MppSessionClient issues one HTTP request per
 * voucher, so voucher N and voucher N+1 routinely land in different isolates.
 * A fresh isolate starts at `lastCumulativeAmount = 0n` with an empty
 * signature, and the DELETE close path then falls back to trusting the
 * client-supplied amount and signature instead of the provider's own tracked
 * values. That is the exact protection the SDK added, defeated by the runtime.
 *
 * A Durable Object restores the single-process assumption the SDK is written
 * against: one instance per channel contract, serialized execution, and memory
 * that persists between requests.
 *
 * The SDK receives a store backed by this object's persistent storage, so mppx
 * channel state survives isolate eviction.
 *
 * Not yet durable: routedockHono still tracks lastCumulativeAmount,
 * voucherCount, lastSignatureHex and sessionPayerAddress in closure scope, and
 * those are what the DELETE close path reads. If this object is evicted
 * mid-session they reset, and close falls back to the client-supplied amount
 * and signature. Moving them into the same store is the remaining half of #211.
 */
export class ChannelSession extends DurableObject<Env> {
  private app: Hono | null = null

  private buildApp(): Hono {
    const env = this.env
    const network: Network = env.STELLAR_NETWORK === 'mainnet' ? 'mainnet' : 'testnet'
    const assetContract = env.USDC_ASSET_CONTRACT ?? ''
    const channelContract = env.CHANNEL_CONTRACT_ID ?? ''

    // mpp-session cannot verify a voucher without the commitment key, so fail
    // loudly here rather than serving a provider that rejects every payment.
    const commitmentPublicKey = env.COMMITMENT_PUBLIC_KEY
    if (!commitmentPublicKey) {
      throw new Error('COMMITMENT_PUBLIC_KEY is required for mpp-session')
    }

    const manifest = buildManifest({
      network,
      payee: env.STELLAR_PAYEE_ADDRESS,
      assetContract,
      channelContract,
    })

    const supabase: SupabaseClient | null =
      env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY
        ? createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY)
        : null

    const providerUrl = `${env.PUBLIC_BASE_URL ?? 'https://api-b.routedock.xyz'}/stream/orderbook`

    const sessionStore = this.ctx?.storage
      ? Store.from({
          get: (key: string) => this.ctx.storage.get(key),
          put: (key: string, value: unknown) => this.ctx.storage.put(key, value),
          delete: async (key: string) => { await this.ctx.storage.delete(key) },
        })
      : Store.memory()

    const app = new Hono()

    app.use(
      '*',
      routedockHono({
        modes: ['mpp-session', 'mpp-session-ws'],
        pricing: {
          'mpp-session': { rate: SESSION_RATE, channelFactory: channelContract },
          'mpp-session-ws': { rate: SESSION_RATE, channelFactory: channelContract },
        },
        asset: 'USDC',
        assetContract,
        payee: env.STELLAR_PAYEE_ADDRESS,
        network,
        payeeSecretKey: env.STELLAR_PAYEE_SECRET,
        commitmentPublicKey,
        sessionStore,
        manifest,
        onSessionOpen: async (channelId, payer) => {
          if (!supabase) return
          const { error } = await supabase.from('sessions').insert({
            channel_id: channelId,
            payee: env.STELLAR_PAYEE_ADDRESS,
            payer: payer ?? 'unknown',
            cumulative_amount: '0',
            status: 'open',
            channel_contract: channelId,
            network,
            voucher_count: 0,
          })
          if (error) console.error('[supabase] session insert failed:', error.message)
        },
        onVoucher: async (channelId, voucherIndex, cumulativeAmount, signature) => {
          if (!supabase) return
          const { error } = await supabase
            .from('sessions')
            .update({
              cumulative_amount: cumulativeAmount,
              voucher_count: voucherIndex,
              last_signature: signature,
            })
            .eq('channel_id', channelId)
          if (error) console.error('[supabase] voucher update failed:', error.message)
        },
        onOrphaned: async (channelId: string, info: OrphanedSessionInfo) => {
          if (!supabase) return
          const { error } = await supabase
            .from('sessions')
            .update({
              status: 'closing',
              cumulative_amount: info.cumulativeAmount,
              last_signature: info.lastSignature || null,
              voucher_count: info.voucherCount,
            })
            .eq('channel_id', channelId)
          if (error) console.error('[supabase] orphan update failed:', error.message)
          else console.log(`[supabase] session marked closing (${info.reason}): ${channelId}`)
        },
        onSettled: async (txHash, totalPaid, mode, payer) => {
          console.log(`[settled] mode=${mode} txHash=${txHash} totalPaid=${totalPaid}`)
          if (!supabase) return

          // Matched on channel_id, not channel_contract. The Express build
          // closed by `.eq('channel_contract', CHANNEL_CONTRACT_ID)` plus
          // `status='open'`, which closes an arbitrary row as soon as two
          // sessions share a channel contract.
          const { error: closeErr } = await supabase
            .from('sessions')
            .update({ status: 'closed', settlement_tx_hash: txHash })
            .eq('channel_id', channelContract)
            .eq('status', 'open')
          if (closeErr) console.error('[supabase] session close failed:', closeErr.message)

          const { error } = await supabase.from('tx_log').insert({
            tx_type: 'channel_close',
            tx_hash: txHash,
            amount: parseFloat(totalPaid),
            mode,
            network,
            provider_url: providerUrl,
            agent_address: payer,
            metadata: { settled_at: new Date().toISOString() },
          })
          if (error) console.error('[supabase] tx_log insert failed:', error.message)
        },
      }),
    )

    // WebSocket transport (mpp-session-ws). Registered before the SSE data
    // route: the routedockHono middleware above verifies the handshake's
    // Payment credential (MPP_SESSION_WS_VERIFIED); upgrade requests are
    // answered with 101 here, everything else falls through to the data route.
    const fetchOrderbook = async () => {
      const params = new URLSearchParams({
        selling_asset_type: 'native',
        buying_asset_type: 'credit_alphanum4',
        buying_asset_code: 'USDC',
        buying_asset_issuer: USDC_ISSUERS[network],
        limit: '5',
      })
      const response = await fetch(`${HORIZON_URLS[network]}/order_book?${params.toString()}`, {
        headers: { accept: 'application/json' },
      })
      if (!response.ok) throw new Error(`Horizon responded ${response.status}`)
      const orderbook = (await response.json()) as OrderBookResponse
      return {
        pair: 'XLM/USDC',
        timestamp: new Date().toISOString(),
        source: 'stellar-dex',
        network,
        asks: orderbook.asks.slice(0, 5).map((a) => ({ price: a.price, amount: a.amount })),
        bids: orderbook.bids.slice(0, 5).map((b) => ({ price: b.price, amount: b.amount })),
      }
    }

    app.get(
      '/stream/orderbook',
      upgradeWebSocket((c) => {
        // Never upgrade a handshake the payment middleware did not verify.
        // (The middleware returns 402 before reaching this route, so this is
        // defense in depth against misconfiguration — fail fast rather than
        // opening an unpaid socket.)
        if (!mppSessionWsVerified(c)) {
          throw new Error('mpp-session-ws: refusing unverified WebSocket handshake')
        }

        let timer: ReturnType<typeof setInterval> | null = null
        let socket: { send: (data: string) => void } | null = null
        const push = async () => {
          try {
            socket?.send(JSON.stringify(await fetchOrderbook()))
          } catch (err) {
            console.error('[horizon] orderbook ws error:', err)
          }
        }

        return {
          onMessage: (_evt, ws) => {
            socket = ws
            // First message kicks off a periodic snapshot push. Cloudflare's
            // WebSocketPair has no onOpen, so a client message is the natural
            // trigger for the stream.
            if (!timer) {
              void push()
              timer = setInterval(() => void push(), 5_000)
            }
            void ws.send(JSON.stringify({ type: 'ack', at: new Date().toISOString() }))
          },
          onClose: () => {
            if (timer) {
              clearInterval(timer)
              timer = null
            }
          },
        }
      }),
    )

    app.get('/stream/orderbook', async (c) => {
      try {
        return c.json(await fetchOrderbook())
      } catch (err) {
        console.error('[horizon] orderbook error:', err)
        return c.json({ error: 'Upstream Horizon error' }, 502)
      }
    })

    return app
  }

  override async fetch(request: Request): Promise<Response> {
    this.app ??= this.buildApp()
    return this.app.fetch(request)
  }
}
