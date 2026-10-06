/**
 * tools.ts
 *
 * MCP tool schema definitions, extracted from index.ts so they can be
 * imported and tested independently without triggering index.ts side-effects
 * (env validation, process.exit, server startup).
 */
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

/**
 * Upper bound on how many streamed messages stream_session may pull in one
 * call. Each message costs one session voucher, and any voucher after the
 * first can reject mid-batch, so an unbounded batch could commit an arbitrary
 * slice of the caller's daily spend cap before failing.
 */
export const MAX_STREAM_MESSAGES = 50

export const TOOLS: Tool[] = [
  {
    name: 'pay_for_data',
    description:
      "Pay for a single data request from a RouteDock provider. Automatically selects the best payment mode (x402, mpp-charge, mpp-session, or mpp-session-ws) based on the provider's manifest. Use mpp-session-ws for WebSocket-transport streaming providers (e.g. provider-b).",
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
          enum: ['x402', 'mpp-charge', 'mpp-session', 'mpp-session-ws'],
          description:
            'Optional preferred payment mode. If not specified, the best mode is selected automatically. mpp-session-ws opens a WebSocket-transport MPP session instead of the default HTTP/SSE variant.',
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
          type: 'integer',
          minimum: 1,
          maximum: MAX_STREAM_MESSAGES,
          description: `Maximum number of messages to pull in this call (1 to ${MAX_STREAM_MESSAGES}, default 1)`,
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
