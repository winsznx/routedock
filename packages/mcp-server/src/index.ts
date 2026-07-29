#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { RouteDockClient } from '@routedock/routedock'
import { createClient } from '@supabase/supabase-js'
import {
  handlePayForData,
  handleOpenSession,
  handleCheckBalance,
  handleListProviders,
} from './handlers.js'

// Environment variables
const STELLAR_SECRET = process.env.STELLAR_SECRET || process.env.ROUTEDOCK_WALLET_SECRET
const STELLAR_NETWORK = (process.env.STELLAR_NETWORK || 'testnet') as 'testnet' | 'mainnet'
const COMMITMENT_SECRET = process.env.COMMITMENT_SECRET
const SUPABASE_URL = process.env.SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY

if (!STELLAR_SECRET) {
  console.error('Error: STELLAR_SECRET or ROUTEDOCK_WALLET_SECRET environment variable is required')
  process.exit(1)
}

// Initialize RouteDock client
const client = new RouteDockClient({
  wallet: STELLAR_SECRET,
  network: STELLAR_NETWORK,
  commitmentSecret: COMMITMENT_SECRET,
})

// Initialize Supabase client for provider registry
let supabase: ReturnType<typeof createClient> | null = null
if (SUPABASE_URL && SUPABASE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
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
      required: ['url'],
    },
  },
  {
    name: 'open_session',
    description: 'Open a sustained MPP session with a provider for streaming data. Requires commitmentSecret to be configured. Returns a session handle for streaming and closing.',
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The base URL of the provider (e.g., https://api-b.routedock.xyz)',
        },
        initial_deposit: {
          type: 'string',
          description: 'Initial deposit amount in USDC for the channel (e.g., "1.0")',
        },
      },
      required: ['url'],
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
    description: 'List available RouteDock providers from the registry. Can filter by capability tags using trigram search.',
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

// Call tool handler — delegates to handlers.ts
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  switch (name) {
    case 'pay_for_data':
      return handlePayForData(
        args as { url: string; max_amount?: string; preferred_mode?: 'x402' | 'mpp-charge' | 'mpp-session' },
        client,
      )
    case 'open_session':
      return handleOpenSession(args as { url: string }, client, COMMITMENT_SECRET)
    case 'check_balance':
      return handleCheckBalance(
        args as { asset_code?: string; asset_issuer?: string },
        STELLAR_SECRET as string,
        STELLAR_NETWORK,
      )
    case 'list_providers':
      return handleListProviders(args as { tags?: string; network?: 'testnet' | 'mainnet' }, supabase)
    default:
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: `Unknown tool: ${name}` }) }],
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
