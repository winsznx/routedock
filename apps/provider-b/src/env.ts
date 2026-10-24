import type { ChannelSession } from './ChannelSession.js'

export interface Env {
  CHANNEL_SESSION: DurableObjectNamespace<ChannelSession>
  STELLAR_NETWORK?: string
  STELLAR_PAYEE_SECRET: string
  STELLAR_PAYEE_ADDRESS: string
  CHANNEL_CONTRACT_ID?: string
  COMMITMENT_PUBLIC_KEY?: string
  /** Agent vault contract (C...) that records session_settled after a clean close. */
  AGENT_VAULT_CONTRACT_ID?: string
  USDC_ASSET_CONTRACT?: string
  SUPABASE_URL?: string
  SUPABASE_SERVICE_KEY?: string
  /** Public origin recorded on settlement, e.g. https://api-b.routedock.xyz */
  PUBLIC_BASE_URL?: string
}
