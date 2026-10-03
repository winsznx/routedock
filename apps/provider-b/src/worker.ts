import type { Env } from './env.js'
import { findConfigProblems } from './config.js'

export { ChannelSession } from './ChannelSession.js'

/**
 * Edge entry point. Everything that touches session state is forwarded to a
 * single Durable Object, named after the channel contract, so all vouchers for
 * a channel serialize through one instance with shared memory.
 *
 * `/health` is answered here because it reads no session state and should stay
 * up even if the object is busy.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/health') {
      const addr = env.STELLAR_PAYEE_ADDRESS
      const missing = findConfigProblems(env)
      return Response.json(
        {
          status: missing.length > 0 ? 'misconfigured' : 'ok',
          network: env.STELLAR_NETWORK === 'mainnet' ? 'mainnet' : 'testnet',
          payee: addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : 'not configured',
          registry: env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY ? 'connected' : 'not configured',
          channel: env.CHANNEL_CONTRACT_ID ? 'configured' : 'not configured',
          ...(missing.length > 0 ? { missing } : {}),
        },
        { status: missing.length > 0 ? 503 : 200 },
      )
    }

    const missing = findConfigProblems(env)
    if (missing.length > 0 || !env.CHANNEL_CONTRACT_ID) {
      return Response.json(
        { error: `Provider misconfigured: ${missing.join(', ')} unset`, missing },
        { status: 500 },
      )
    }

    const id = env.CHANNEL_SESSION.idFromName(env.CHANNEL_CONTRACT_ID)
    return env.CHANNEL_SESSION.get(id).fetch(request)
  },

  /**
   * Cron trigger entry point (runs every 15 minutes).
   * Forwards reconciliation to the ChannelSession Durable Object so settlement
   * serializes against live voucher traffic instead of racing it.
   */
  async scheduled(
    _controller: unknown,
    env: Env,
    _ctx?: unknown,
  ): Promise<void> {
    if (!env.CHANNEL_CONTRACT_ID || !env.CHANNEL_SESSION) {
      console.warn('[reconcile] Skipped: CHANNEL_CONTRACT_ID or the CHANNEL_SESSION binding is not set')
      return
    }
    const id = env.CHANNEL_SESSION.idFromName(env.CHANNEL_CONTRACT_ID)
    const stub = env.CHANNEL_SESSION.get(id)
    const stats = await stub.reconcileSessions()

    if (!stats) {
      console.warn('[reconcile] Skipped: SUPABASE_URL, SUPABASE_SERVICE_KEY or STELLAR_PAYEE_SECRET is not set')
      return
    }

    console.log(
      `[reconcile] orphaned=${stats.orphanedCount} recovered=${stats.recoveredCount} ` +
        `skipped=${stats.skippedCount} failed=${stats.failedCount}`,
    )
    for (const { channelId, reason } of stats.errors) {
      console.error(`[reconcile] close failed for ${channelId}: ${reason}`)
    }
  },
}

