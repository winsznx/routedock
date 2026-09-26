/**
 * tools.ts
 *
 * MCP tool schema definitions, extracted from index.ts so they can be
 * imported and tested independently without triggering index.ts side-effects
 * (env validation, process.exit, server startup).
 */
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

export const TOOLS: Tool[] = [
  {
    name: 'pay_for_data',
    description:
      "Pay for a single data request from a RouteDock provider using x402 or mpp-charge. For streaming providers, use open_session instead.",
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'The full URL of the provider endpoint to pay for (e.g., https://api-a.routedock.xyz/price)',
        },
        max_amount: {
          type: 'string',
          description: 'Maximum amount in USDC to pay for this request (e.g., "0.01")',
        },
        preferred_mode: {
          type: 'string',
          enum: ['x402', 'mpp-charge'],
          description:
            'Optional preferred payment mode for a single request.',
        },
      },
      required: ['url', 'max_amount'],
    },
  },
  {
    name: 'open_session',
    description:
      "Open a sustained MPP session with a provider for streaming data. Requires COMMITMENT_SECRET to be configured. Returns a channel_id — pass it to stream_session to pull data and to close_session when done, or the channel collateral can never be settled.",
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The base URL of the provider (e.g., https://api-b.routedock.xyz)',
        },
        initial_deposit: {
          type: 'string',
          description:
            "Amount in USDC you intend the channel to be funded with (e.g., \"1.0\"). RouteDock channels are pre-deployed and funded out-of-band before the agent runs — this is checked against the provider's advertised min_deposit as a safety guard, it does not itself move funds.",
        },
        mode: {
          type: 'string',
          enum: ['mpp-session', 'mpp-session-ws'],
          description: 'Optional session transport. Defaults to mpp-session; choose mpp-session-ws for WebSocket streaming.',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'stream_session',
    description:
      'Pull the next batch of streamed responses from a session opened with open_session. Each message sends a voucher and waits for the provider to acknowledge it. Call repeatedly to keep streaming, then call close_session to settle and release the channel.',
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
    description:
      "Close an MPP session opened with open_session, settling the channel on-chain with the highest signed voucher. This is required to release the session's locked collateral — an open session left unclosed keeps funds locked until the SDK's wall-clock auto-close guard fires.",
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
          description:
            'Optional asset code to check (e.g., "USDC"). If not specified, returns native XLM balance.',
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
    description:
      'List available RouteDock providers from the registry. Can filter by capability tags (returns providers matching any of the given tags) and by network.',
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
