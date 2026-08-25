import type { Env } from './env.js'

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
      return Response.json({
        status: 'ok',
        network: env.STELLAR_NETWORK === 'mainnet' ? 'mainnet' : 'testnet',
        payee: addr ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : 'not configured',
        registry: env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY ? 'connected' : 'not configured',
        channel: env.CHANNEL_CONTRACT_ID ? 'configured' : 'not configured',
      })
    }

    if (!env.CHANNEL_CONTRACT_ID) {
      return Response.json({ error: 'Provider misconfigured: CHANNEL_CONTRACT_ID unset' }, { status: 500 })
    }

    const id = env.CHANNEL_SESSION.idFromName(env.CHANNEL_CONTRACT_ID)
    return env.CHANNEL_SESSION.get(id).fetch(request)
  },
}
