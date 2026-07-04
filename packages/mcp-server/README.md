# @routedock/mcp-server

Model Context Protocol (MCP) server for RouteDock Stellar payments. Exposes RouteDock's payment functionality as standardized tools that LLM agents can use directly.

## Overview

This MCP server implements the thesis that base payment infrastructure should be built for machines, not humans. Instead of requiring every LLM agent to implement the full RouteDock SDK, agents can simply connect to this MCP server and use standardized tools:

- `pay_for_data(url, max_amount)` - Pay for a single data request
- `open_session(url)` - Open a sustained MPP session for streaming
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

Set the following environment variables:

```bash
# Required
export STELLAR_SECRET="S..."  # Your Stellar secret key
export STELLAR_NETWORK="testnet"  # or "mainnet"

# Optional (for session mode)
export COMMITMENT_SECRET="S..."  # Ed25519 secret for channel commitments

# Optional (for provider registry)
export SUPABASE_URL="https://..."
export SUPABASE_KEY="..."
```

## Available Tools

### pay_for_data

Pay for a single data request from a RouteDock provider. Automatically selects the best payment mode.

**Parameters:**
- `url` (required): Full URL of the provider endpoint
- `max_amount` (optional): Maximum USDC amount to pay
- `preferred_mode` (optional): Preferred payment mode (`x402`, `mpp-charge`, `mpp-session`)

**Returns:** Payment result with mode, amount, transaction hash, and response data

### open_session

Open a sustained MPP session for streaming data. Requires `COMMITMENT_SECRET`.

**Parameters:**
- `url` (required): Base URL of the provider
- `initial_deposit` (optional): Initial deposit amount in USDC

**Returns:** Session handle with channel ID and open transaction hash

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
        "STELLAR_SECRET": "S...",
        "STELLAR_NETWORK": "testnet",
        "COMMITMENT_SECRET": "S...",
        "SUPABASE_URL": "https://...",
        "SUPABASE_KEY": "..."
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
