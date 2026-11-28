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

/**
 * Upper bound on how many provider rows list_providers may return.  Each row
 * adds its modes, tags and accepted assets to the model's context, so the
 * registry query is bounded rather than dumping the whole table (issue #566).
 */
export const MAX_PROVIDER_ROWS = 50

/**
 * Upper bound, in bytes, on the request body pay_for_data will forward. The
 * body comes from the model, so it is bounded rather than relayed unchecked.
 */
export const MAX_REQUEST_BODY_BYTES = 64 * 1024

/** HTTP methods pay_for_data may use for the paid request. */
export const REQUEST_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

/**
 * Tool annotations. MCP clients use these to decide what can run without a
 * confirmation prompt. The read-only tools never move funds or change state;
 * the spending tools are not idempotent (repeating a call pays again) and
 * talk to an open world of third-party providers.
 */
const READ_ONLY = { readOnlyHint: true } as const
const SPENDS = { destructiveHint: true, idempotentHint: false, openWorldHint: true } as const

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
        method: {
          type: 'string',
          enum: [...REQUEST_METHODS],
          description:
            'Optional HTTP method for the paid request (default GET). Use POST (or PUT/PATCH/DELETE) for providers whose endpoint takes a request body.',
        },
        headers: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description:
            'Optional extra request headers as a name-to-value map (e.g. {"content-type": "application/json"}). Authorization and x-payment* headers are rejected: payment headers are set by RouteDock.',
        },
        body: {
          type: 'string',
          maxLength: MAX_REQUEST_BODY_BYTES,
          description: `Optional request body, sent as-is (e.g. a JSON string), at most ${MAX_REQUEST_BODY_BYTES} bytes (64 KiB). Not allowed with GET.`,
        },
      },
      required: ['url', 'max_amount'],
    },
    annotations: SPENDS,
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
          description:
            "The provider's streaming endpoint URL (e.g., https://api-b.routedock.xyz/stream/orderbook). Vouchers and the closing DELETE go to this exact URL. A bare origin (e.g., https://api-b.routedock.xyz) is also accepted and resolved to the provider's streaming endpoint from its /.well-known/routedock.json manifest.",
        },
        initial_deposit: {
          type: 'string',
          description:
            "Amount in USDC you intend the channel to be funded with (e.g., \"1.0\"). RouteDock channels are pre-deployed and funded out-of-band before the agent runs — this is checked against the provider's advertised min_deposit as a safety guard, it does not itself move funds.",
        },
      },
      required: ['url'],
    },
    annotations: SPENDS,
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
    annotations: SPENDS,
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
    annotations: SPENDS,
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
            'Optional asset code to check (e.g., "USDC"). If not specified, returns native XLM balance. Without asset_issuer, "USDC" is matched to the canonical Circle issuer for this network; any other code the account holds from several issuers returns all of them so you can choose one.',
        },
        asset_issuer: {
          type: 'string',
          description:
            'Asset issuer address for non-native assets. Anyone can issue an asset with a popular code, so pass this to read a specific issuer rather than the canonical USDC one.',
        },
      },
      required: [],
    },
    annotations: READ_ONLY,
  },
  {
    name: 'list_providers',
    description:
      'List available RouteDock providers from the registry (Supabase and on-chain accounts, merged), bounded to a maximum of 50 rows. Each row includes the provider\'s registered payee. Can filter by capability tags (returns providers matching any of the given tags) and by network; without a network the server only returns providers on its own configured network.',
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
          description:
            'Filter by Stellar network. Defaults to the network this server is configured with (STELLAR_NETWORK), so providers that cannot be paid from here are not returned.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_PROVIDER_ROWS,
          description: `Maximum number of providers to return (1 to ${MAX_PROVIDER_ROWS}, default ${MAX_PROVIDER_ROWS})`,
        },
      },
      required: [],
    },
    annotations: READ_ONLY,
  },
  {
    name: 'quote_provider',
    description:
      "Get a provider's price without paying. Returns every payment mode the provider supports with its cost (per request, or per voucher with min_deposit for session modes) and deprecation/sunset flags. Call this before pay_for_data or open_session to choose a max_amount instead of guessing.",
    inputSchema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description:
            'The full URL of the provider endpoint to quote (e.g., https://api-a.routedock.xyz/price)',
        },
      },
      required: ['url'],
    },
    annotations: READ_ONLY,
  },
  {
    name: 'get_spend_status',
    description:
      'Show how much of this server\'s daily spend cap (ROUTEDOCK_DAILY_CAP) has been used today and how much remains, plus any per-endpoint caps. Call this before planning several paid calls.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    annotations: READ_ONLY,
  },
]
