#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { RouteDockClient } from '@routedock/routedock'
import { Keypair, Horizon } from '@stellar/stellar-sdk'
import { createClient } from '@supabase/supabase-js'

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
  return {
    tools: TOOLS,
  }
})

// Call tool handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  try {
    switch (name) {
      case 'pay_for_data': {
        const { url, max_amount, preferred_mode } = args as {
          url: string
          max_amount?: string
          preferred_mode?: 'x402' | 'mpp-charge' | 'mpp-session'
        }

        // Fetch manifest first to check pricing
        const baseUrl = new URL(url).origin
        const horizonUrl = STELLAR_NETWORK === 'mainnet' 
          ? 'https://horizon.stellar.org' 
          : 'https://horizon-testnet.stellar.org'
        
        // Check if max_amount is specified and validate against pricing
        if (max_amount) {
          const manifestResponse = await fetch(`${baseUrl}/.well-known/routedock.json`)
          const manifest = await manifestResponse.json()
          
          const pricing = manifest.pricing[preferred_mode || 'x402'] || manifest.pricing['x402']
          if (pricing && parseFloat(pricing.amount) > parseFloat(max_amount)) {
            throw new Error(`Provider cost ${pricing.amount} exceeds max_amount ${max_amount}`)
          }
        }

        const result = await client.pay(url, { preferredMode: preferred_mode })
        
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
        const { url } = args as { url: string }

        if (!COMMITMENT_SECRET) {
          throw new Error('COMMITMENT_SECRET environment variable is required for session mode')
        }

        const session = await client.openSession(url)
        
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                channel_id: session.channelId,
                open_tx_hash: session.openTxHash,
                message: 'Session opened successfully. Use the session handle to stream data or close the session.',
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
          const tagList = tags.split(',').map(t => t.trim())
          // Use trigram search for each tag
          for (const tag of tagList) {
            query = query.textSearch('tags', tag)
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
