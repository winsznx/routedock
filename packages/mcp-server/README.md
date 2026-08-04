# @routedock/mcp-server

Model Context Protocol (MCP) server for RouteDock Stellar payments. Exposes RouteDock's payment functionality as standardized tools that LLM agents can use directly.

## Overview

This MCP server implements the thesis that base payment infrastructure should be built for machines, not humans. Instead of requiring every LLM agent to implement the full RouteDock SDK, agents can simply connect to this MCP server and use standardized tools:

- `pay_for_data(url, max_amount)` - Pay for a single data request
- `open_session(url)` - Open a sustained MPP session for streaming
- `stream_session(channel_id)` - Pull streamed data from an open session
- `close_session(channel_id)` - Settle and close an open session
- `check_balance()` - Check wallet balance
- `list_providers(tags)` - Discover available providers

## Installation

```bash
npm install -g @routedock/mcp-server
```

Or build from source:

```bash
cd packages/mcp-server
pnpm install
pnpm build
```

## Configuration

For security, it is highly recommended to store your secrets in an external `.env` file rather than inline in the Claude Desktop configuration.

Create a `.env` file (e.g., `~/.routedock/.env`):

```bash
# Required
STELLAR_SECRET="SDU5..."  # Use a dedicated low-balance testnet key for safety
STELLAR_NETWORK="testnet"  # or "mainnet"
ROUTEDOCK_DAILY_CAP="1.00" # Required: Maximum daily spend in USDC

# Optional (for session mode)
COMMITMENT_SECRET="S..."  # Ed25519 secret for channel commitments

# Optional (for provider registry)
SUPABASE_URL="https://..."
# Note: Use the anon key (anon + public_read_providers RLS is sufficient). Do NOT use the service-role key.
SUPABASE_KEY="..."
```

## Available Tools

### pay_for_data

Pay for a single data request from a RouteDock provider. Automatically selects the best payment mode.

**Parameters:**
- `url` (required): Full URL of the provider endpoint
- `max_amount` (required): Maximum USDC amount to pay
- `preferred_mode` (optional): Preferred payment mode (`x402`, `mpp-charge`, `mpp-session`)

**Returns:** Payment result with mode, amount, transaction hash, and response data

### open_session

Open a sustained MPP session for streaming data. Requires `COMMITMENT_SECRET`. RouteDock channels
are pre-deployed and funded out-of-band before the agent runs, so `initial_deposit` is a safety
check against the provider's `min_deposit`, not a fund transfer. Pass the returned `channel_id` to
`stream_session` and `close_session` — the channel's collateral cannot be settled otherwise.

**Parameters:**
- `url` (required): Base URL of the provider
- `initial_deposit` (optional): Amount in USDC you intend the channel to be funded with

**Returns:** `channel_id` and open transaction hash

### stream_session

Pull the next batch of streamed responses from a session opened with `open_session`. Each message
sends a voucher and waits for the provider's response.

**Parameters:**
- `channel_id` (required): The `channel_id` returned by `open_session`
- `max_messages` (optional): Maximum number of messages to pull in this call (default 1)

**Returns:** The pulled messages

### close_session

Close a session opened with `open_session`, settling the channel on-chain with the highest signed
voucher. Required to release the session's locked collateral.

**Parameters:**
- `channel_id` (required): The `channel_id` returned by `open_session`

**Returns:** Close transaction hash, total amount paid, and vouchers issued

### check_balance

Check the Stellar wallet balance for the configured account.

**Parameters:**
- `asset_code` (optional): Asset code to check (e.g., "USDC")
- `asset_issuer` (optional): Asset issuer address for non-native assets

**Returns:** Balance information for the specified asset

### list_providers

List available RouteDock providers from the registry. Requires Supabase credentials.

**Parameters:**
- `tags` (optional): Comma-separated tags for filtering (e.g., "price,stellar,dex")
- `network` (optional): Filter by network (`testnet` or `mainnet`)

**Returns:** List of matching providers with their capabilities

## Claude Desktop Configuration

Add this to your Claude Desktop config file:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "routedock": {
      "command": "node",
      "args": ["/path/to/@routedock/mcp-server/dist/index.js"],
      "env": {
        "ROUTEDOCK_ENV_FILE": "/absolute/path/to/your/.env"
      }
    }
  }
}
```

## Example Usage

Once configured, you can ask Claude to:

> "Check my Stellar balance"
> "List providers that offer price data"
> "Pay for data from https://api-a.routedock.xyz/price with a max of 0.01 USDC"
> "Open a session with https://api-b.routedock.xyz for streaming orderbook data"
> "Pull the next few messages from that session"
> "Close the session and settle the channel"

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Watch mode
pnpm dev

# Type check
pnpm typecheck

# Run directly
pnpm start
```

## Architecture

The MCP server wraps the existing `@routedock/routedock` SDK and exposes its functionality through the Model Context Protocol. This allows any MCP-compatible LLM client (Claude Desktop, etc.) to interact with Stellar payments without implementing the SDK directly.

```
LLM Agent → MCP Protocol → @routedock/mcp-server → @routedock/routedock SDK → Stellar Network
```

## License

MIT
