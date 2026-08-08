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
import { createClient } from '@supabase/supabase-js'
import {
  handlePayForData,
  handleOpenSession,
  handleStreamSession,
  handleCloseSession,
  handleCheckBalance,
  handleListProviders,
  type HandlerDeps,
  type PayForDataArgs,
  type OpenSessionArgs,
  type StreamSessionArgs,
  type CloseSessionArgs,
  type CheckBalanceArgs,
  type ListProvidersArgs,
} from './handlers.js'

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

// Shared dependency bundle passed into every handler
const deps: HandlerDeps = {
  client,
  openSessions,
  supabase: supabase as HandlerDeps['supabase'],
  stellarSecret: STELLAR_SECRET,
  stellarNetwork: STELLAR_NETWORK,
}

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

// Call tool handler — delegates to pure handler functions in handlers.ts
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  try {
    switch (name) {
      case 'pay_for_data':
        return await handlePayForData(args as unknown as PayForDataArgs, deps)

      case 'open_session':
        return await handleOpenSession(args as unknown as OpenSessionArgs, deps, COMMITMENT_SECRET)

      case 'stream_session':
        return await handleStreamSession(args as unknown as StreamSessionArgs, deps)

      case 'close_session':
        return await handleCloseSession(args as unknown as CloseSessionArgs, deps)

      case 'check_balance':
        return await handleCheckBalance(args as unknown as CheckBalanceArgs, deps)

      case 'list_providers':
        return await handleListProviders(args as unknown as ListProvidersArgs, deps)

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
