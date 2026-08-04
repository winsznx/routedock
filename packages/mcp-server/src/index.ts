import { config as loadDotenv } from 'dotenv'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { RouteDockClient } from '@routedock/routedock'
import type { SessionHandle } from '@routedock/routedock'
import { Keypair, Horizon } from '@stellar/stellar-sdk'
import { createClient } from '@supabase/supabase-js'

// Load environment variables (supports .env files for external secret management)
const envPath = process.env.ROUTEDOCK_ENV_FILE
if (envPath) {
  loadDotenv({ path: envPath })
} else {
  loadDotenv()
}

// Environment variables
const STELLAR_SECRET = process.env.STELLAR_SECRET || process.env.ROUTEDOCK_WALLET_SECRET
const STELLAR_NETWORK = (process.env.STELLAR_NETWORK || 'testnet') as 'testnet' | 'mainnet'
const COMMITMENT_SECRET = process.env.COMMITMENT_SECRET
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_KEY

if (process.env.SUPABASE_SERVICE_KEY) {
  console.warn('WARNING: Using SUPABASE_SERVICE_KEY bypasses RLS. Use an anon key for list_providers (anon + public_read_providers RLS is sufficient).')
}

if (!STELLAR_SECRET) {
  console.error('Error: STELLAR_SECRET or ROUTEDOCK_WALLET_SECRET environment variable is required')
  process.exit(1)
}

const ROUTEDOCK_DAILY_CAP = process.env.ROUTEDOCK_DAILY_CAP
if (!ROUTEDOCK_DAILY_CAP) {
  console.error('Error: ROUTEDOCK_DAILY_CAP environment variable is required to prevent unbounded spending')
  process.exit(1)
}

// Simple durable spend store for MCP server
class FileSpendStore {
  private filePath: string
  constructor(filePath: string) {
    this.filePath = filePath
  }
  async read(): Promise<any | null> {
    try {
      const data = await fs.readFile(this.filePath, 'utf-8')
      return JSON.parse(data)
    } catch (e: any) {
      return null
    }
  }
  async write(state: any): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await fs.writeFile(this.filePath, JSON.stringify(state, null, 2), 'utf-8')
  }
}

const spendStorePath = process.env.ROUTEDOCK_SPEND_STORE_PATH || path.join(os.homedir(), '.routedock', 'spend.json')
// Initialize RouteDock client
const client = new RouteDockClient({
  wallet: STELLAR_SECRET,
  network: STELLAR_NETWORK,
  commitmentSecret: COMMITMENT_SECRET,
  spendCap: { daily: ROUTEDOCK_DAILY_CAP, asset: 'USDC' },
  spendStore: new FileSpendStore(spendStorePath),
})

// Initialize Supabase client for provider registry
let supabase: ReturnType<typeof createClient> | null = null
if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
}

// Sessions opened via open_session, keyed by channelId, so a later
// close_session/stream_session call in the same server process can find the
// live handle again. If the process restarts, in-flight sessions are not
// recoverable here — the SDK's own maxDurationMs guard still auto-closes the
// underlying channel on-chain so collateral is never stranded indefinitely.
const openSessions = new Map<string, SessionHandle>()

// Tool definitions
const TOOLS: Tool[] = [
  {
    name: 'pay_for_data',
    description: 'Pay for a single data request from a RouteDock provider. Automatically selects the best payment mode (x402, mpp-charge, or mpp-session) based on the provider\'s manifest.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The full URL of the provider endpoint to pay for (e.g., https://api-a.routedock.xyz/price)',
        },
        max_amount: {
          type: 'string',
          description: 'Maximum amount in USDC to pay for this request (e.g., "0.01")',
        },
        preferred_mode: {
          type: 'string',
          enum: ['x402', 'mpp-charge', 'mpp-session'],
          description: 'Optional preferred payment mode. If not specified, the best mode is selected automatically.',
        },
      },
      required: ['url', 'max_amount'],
    },
  },
  {
    name: 'open_session',
    description: 'Open a sustained MPP session with a provider for streaming data. Requires COMMITMENT_SECRET to be configured. Returns a channel_id — pass it to stream_session to pull data and to close_session when done, or the channel collateral can never be settled.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The base URL of the provider (e.g., https://api-b.routedock.xyz)',
        },
        initial_deposit: {
          type: 'string',
          description: 'Amount in USDC you intend the channel to be funded with (e.g., "1.0"). RouteDock channels are pre-deployed and funded out-of-band before the agent runs — this is checked against the provider\'s advertised min_deposit as a safety guard, it does not itself move funds.',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'stream_session',
    description: 'Pull the next batch of streamed responses from a session opened with open_session. Each message sends a voucher and waits for the provider to acknowledge it. Call repeatedly to keep streaming, then call close_session to settle and release the channel.',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: {
          type: 'string',
          description: 'The channel_id returned by open_session',
        },
        max_messages: {
          type: 'number',
          description: 'Maximum number of messages to pull in this call (default 1)',
        },
      },
      required: ['channel_id'],
    },
  },
  {
    name: 'close_session',
    description: 'Close an MPP session opened with open_session, settling the channel on-chain with the highest signed voucher. This is required to release the session\'s locked collateral — an open session left unclosed keeps funds locked until the SDK\'s wall-clock auto-close guard fires.',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: {
          type: 'string',
          description: 'The channel_id returned by open_session',
        },
      },
      required: ['channel_id'],
    },
  },
  {
    name: 'check_balance',
    description: 'Check the Stellar wallet balance for the configured account',
    inputSchema: {
      type: 'object',
      properties: {
        asset_code: {
          type: 'string',
          description: 'Optional asset code to check (e.g., "USDC"). If not specified, returns native XLM balance.',
        },
        asset_issuer: {
          type: 'string',
          description: 'Optional asset issuer address for non-native assets',
        },
      },
      required: [],
    },
  },
  {
    name: 'list_providers',
    description: 'List available RouteDock providers from the registry. Can filter by capability tags (returns providers matching any of the given tags) and by network.',
    inputSchema: {
      type: 'object',
      properties: {
        tags: {
          type: 'string',
          description: 'Comma-separated tags to filter providers (e.g., "price,stellar,dex")',
        },
        network: {
          type: 'string',
          enum: ['testnet', 'mainnet'],
          description: 'Filter by Stellar network',
        },
      },
      required: [],
    },
  },
]

// Create MCP server
const server = new Server(
  {
    name: '@routedock/mcp-server',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
)

// List tools handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS }
})

// Call tool handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  try {
    switch (name) {
      case 'pay_for_data': {
        const { url, max_amount, preferred_mode } = args as {
          url: string
          max_amount: string
          preferred_mode?: 'x402' | 'mpp-charge' | 'mpp-session'
        }

        // preferred_mode maps to ModeSelectOptions.forceMode; the field is not
        // called preferredMode, so passing that name silently drops it (#199).
        const modeOptions = preferred_mode
          ? { forceMode: preferred_mode as import('@routedock/routedock').PaymentMode }
          : undefined

        // Validate price for the exact selected mode. max_amount is a required
        // tool argument, so this cap is unconditional (#144).
        const estimate = await client.estimateCost(url, modeOptions)

        if (estimate.amount === undefined || isNaN(parseFloat(estimate.amount))) {
          throw new Error('Provider returned an undefined or invalid price')
        }

        if (parseFloat(estimate.amount) > parseFloat(max_amount)) {
          throw new Error(`Provider cost ${estimate.amount} ${estimate.asset} exceeds max_amount ${max_amount} USDC`)
        }

        const result = await client.pay(url, modeOptions)
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                mode: result.mode,
                amount: result.amount,
                tx_hash: result.txHash,
                timestamp: result.timestamp,
                data: result.data,
              }, null, 2),
            },
          ],
        }
      }

      case 'open_session': {
        const { url, initial_deposit } = args as { url: string; initial_deposit?: string }

        if (!COMMITMENT_SECRET) {
          throw new Error('COMMITMENT_SECRET environment variable is required for session mode')
        }

        if (initial_deposit) {
          const baseUrl = new URL(url).origin
          const manifestResponse = await fetch(`${baseUrl}/.well-known/routedock.json`)
          const manifest = (await manifestResponse.json()) as { pricing?: Record<string, { min_deposit?: string }> }
          const minDeposit = manifest?.pricing?.['mpp-session']?.min_deposit
          if (minDeposit && parseFloat(initial_deposit) < parseFloat(minDeposit)) {
            throw new Error(
              `initial_deposit ${initial_deposit} is below this provider's min_deposit ${minDeposit}. ` +
              `RouteDock channels are pre-deployed and funded out-of-band before the agent runs — ` +
              `make sure the channel is funded with at least min_deposit before opening a session.`
            )
          }
        }

        const session = await client.openSession(url)
        openSessions.set(session.channelId, session)

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                channel_id: session.channelId,
                open_tx_hash: session.openTxHash,
                message: 'Session opened successfully. Use stream_session to pull data and close_session to settle and release the channel collateral.',
              }, null, 2),
            },
          ],
        }
      }

      case 'stream_session': {
        const { channel_id, max_messages } = args as { channel_id: string; max_messages?: number }

        const session = openSessions.get(channel_id)
        if (!session) {
          throw new Error(
            `No open session found for channel_id ${channel_id}. It may have already been closed, ` +
            `auto-closed after its wall-clock lifetime guard, or opened by a different server process.`
          )
        }

        const limit = Math.max(1, max_messages ?? 1)
        const messages: unknown[] = []
        const iterator = session.stream()[Symbol.asyncIterator]()
        for (let i = 0; i < limit; i++) {
          const { value, done } = await iterator.next()
          if (done) break
          messages.push(value)
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                channel_id,
                count: messages.length,
                messages,
              }, null, 2),
            },
          ],
        }
      }

      case 'close_session': {
        const { channel_id } = args as { channel_id: string }

        const session = openSessions.get(channel_id)
        if (!session) {
          throw new Error(
            `No open session found for channel_id ${channel_id}. It may have already been closed or ` +
            `auto-closed after its wall-clock lifetime guard.`
          )
        }

        const result = await session.close()
        openSessions.delete(channel_id)

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                channel_id,
                close_tx_hash: result.closeTxHash,
                total_paid: result.totalPaid,
                vouchers_issued: result.vouchersIssued,
              }, null, 2),
            },
          ],
        }
      }

      case 'check_balance': {
        const { asset_code, asset_issuer } = args as {
          asset_code?: string
          asset_issuer?: string
        }

        const keypair = typeof STELLAR_SECRET === 'string' 
          ? Keypair.fromSecret(STELLAR_SECRET) 
          : STELLAR_SECRET
        
        const horizonUrl = STELLAR_NETWORK === 'mainnet' 
          ? 'https://horizon.stellar.org' 
          : 'https://horizon-testnet.stellar.org'
        
        const server = new Horizon.Server(horizonUrl)
        const account = await server.loadAccount(keypair.publicKey())
        
        if (asset_code && asset_issuer) {
          // Check specific asset balance
          const balance = account.balances.find(
            (b: any) => b.asset_code === asset_code && b.asset_issuer === asset_issuer
          )
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  asset: asset_code,
                  issuer: asset_issuer,
                  balance: balance ? balance.balance : '0',
                  account: keypair.publicKey(),
                }, null, 2),
              },
            ],
          }
        } else if (asset_code) {
          // Check asset by code only (first match)
          const balance = account.balances.find((b: any) => b.asset_code === asset_code)
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  asset: asset_code,
                  balance: balance ? balance.balance : '0',
                  account: keypair.publicKey(),
                }, null, 2),
              },
            ],
          }
        } else {
          // Return native XLM balance
          const nativeBalance = account.balances.find((b: any) => b.asset_type === 'native')
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  asset: 'XLM',
                  balance: nativeBalance ? nativeBalance.balance : '0',
                  account: keypair.publicKey(),
                }, null, 2),
              },
            ],
          }
        }
      }

      case 'list_providers': {
        const { tags, network } = args as {
          tags?: string
          network?: 'testnet' | 'mainnet'
        }

        if (!supabase) {
          throw new Error('SUPABASE_URL and SUPABASE_KEY environment variables are required for provider registry access')
        }

        let query = supabase.from('providers').select('*')

        if (network) {
          query = query.eq('network', network)
        }

        if (tags) {
          const tagList = tags.split(',').map(t => t.trim()).filter(Boolean)
          // tags is a TEXT[] column (see idx_providers_tags GIN index) — array
          // overlap, not to_tsvector/textSearch, is the correct operator here.
          if (tagList.length > 0) {
            query = query.overlaps('tags', tagList)
          }
        }

        const { data, error } = await query

        if (error) {
          throw new Error(`Failed to fetch providers: ${error.message}`)
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                count: data?.length || 0,
                providers: data?.map((p: any) => ({
                  name: p.name,
                  description: p.description,
                  network: p.network,
                  asset: p.asset,
                  modes: p.modes,
                  tags: p.tags,
                  base_url: p.base_url,
                })) || [],
              }, null, 2),
            },
          ],
        }
      }

      default:
        throw new Error(`Unknown tool: ${name}`)
    }
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: error instanceof Error ? error.message : String(error),
          }, null, 2),
        },
      ],
      isError: true,
    }
  }
})

// Start server
async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('@routedock/mcp-server running on stdio')
}

main().catch((error) => {
  console.error('Server error:', error)
  process.exit(1)
})
