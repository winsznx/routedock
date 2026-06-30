# RouteDock MCP Server

## Overview

The `@routedock/mcp-server` package implements a Model Context Protocol (MCP) server that exposes RouteDock's Stellar payment functionality as standardized tools for LLM agents. This addresses the core thesis that base payment infrastructure should be built for machines, not humans.

## Problem Solved

Previously, every LLM agent wanting to make Stellar payments had to:
- Implement the full RouteDock SDK
- Understand x402, MPP charge, and MPP session protocols
- Handle manifest discovery and validation
- Manage wallet keys and signing
- Implement dispute resolution for sessions

With the MCP server, agents simply connect to a local MCP server and use standardized tools without any payment-specific implementation.

## Architecture

```
┌─────────────┐
│ LLM Agent   │
└──────┬──────┘
       │ MCP Protocol
       ▼
┌──────────────────────┐
│ @routedock/mcp-server│
└──────┬───────────────┘
       │
       ▼
┌──────────────────────┐
│ @routedock/routedock │
│       SDK            │
└──────┬───────────────┘
       │
       ▼
┌──────────────────────┐
│  Stellar Network     │
└──────────────────────┘
```

## Available Tools

### 1. pay_for_data(url, max_amount, preferred_mode)

Pay for a single data request from a RouteDock provider. Automatically selects the best payment mode based on the provider's manifest.

**Use case:** One-off API calls, price feeds, single data queries

**Returns:** Payment result with mode, amount, transaction hash, and response data

### 2. open_session(url, initial_deposit)

Open a sustained MPP session for streaming data. Uses off-chain vouchers for low-cost repeated access.

**Use case:** Streaming orderbooks, real-time data feeds, sustained access

**Returns:** Session handle with channel ID and open transaction hash

### 3. check_balance(asset_code, asset_issuer)

Check the Stellar wallet balance for the configured account.

**Use case:** Verify sufficient funds before payments, monitor account status

**Returns:** Balance information for the specified asset

### 4. list_providers(tags, network)

List available RouteDock providers from the registry with trigram search.

**Use case:** Discover providers by capability, find services for specific needs

**Returns:** List of matching providers with their capabilities

## Quick Start

### Installation

```bash
cd packages/mcp-server
pnpm install
pnpm build
```

### Claude Desktop Configuration

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "routedock": {
      "command": "node",
      "args": ["/absolute/path/to/packages/mcp-server/dist/index.js"],
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

### Example Usage

Once configured, ask Claude:

> "Check my Stellar balance"
> "List providers that offer price data"
> "Pay for data from https://api-a.routedock.xyz/price with a max of 0.01 USDC"
> "Open a session with https://api-b.routedock.xyz for streaming orderbook data"

## Implementation Details

### Tool Schema

Each tool follows the MCP tool schema with:
- `name`: Tool identifier
- `description`: Human-readable description for the LLM
- `inputSchema`: JSON Schema for parameters

### Error Handling

All tools return structured error responses:
```json
{
  "success": false,
  "error": "Error message"
}
```

### Environment Variables

- `STELLAR_SECRET`: Required - Wallet secret key
- `STELLAR_NETWORK`: Required - "testnet" or "mainnet"
- `COMMITMENT_SECRET`: Optional - For session mode
- `SUPABASE_URL`: Optional - For provider registry
- `SUPABASE_KEY`: Optional - For provider registry

### Security

- All secrets are stored locally in environment variables
- MCP server runs locally on stdio (no network exposure)
- Secrets are never transmitted to external services
- Wallet operations use the existing RouteDock SDK security model

## Testing with Live Providers

The MCP server works with the live RouteDock testnet providers:

- **Provider A**: https://api-a.routedock.xyz
  - Modes: x402, mpp-charge
  - Endpoint: /price
  - Use case: Single price requests

- **Provider B**: https://api-b.routedock.xyz
  - Modes: mpp-session
  - Endpoint: /stream/orderbook
  - Use case: Streaming orderbook data

## Future Enhancements

Potential additions to the MCP server:

1. **Session streaming tool**: Expose the session stream() as an MCP resource
2. **Session close tool**: Explicit close operation with settlement details
3. **Dispute resolution tools**: Expose refund and settlement operations
4. **Transaction history tool**: Query past payments and sessions
5. **Provider manifest tool**: Direct manifest inspection
6. **Multi-wallet support**: Switch between multiple configured wallets

## Comparison: Before vs After

### Before (SDK Implementation)

```typescript
import { RouteDockClient } from '@routedock/routedock'

const client = new RouteDockClient({
  wallet: secretKey,
  network: 'testnet',
  commitmentSecret: commitmentKey
})

const result = await client.pay(url, { preferredMode: 'x402' })
// Handle errors, parse results, manage state...
```

### After (MCP Server)

```
User: "Pay for data from https://api-a.routedock.xyz/price"

Claude: (calls pay_for_data tool automatically)
Result: Payment successful, mode: x402, amount: 0.001 USDC
```

## Impact

The MCP server dramatically lowers the barrier for LLM agents to use Stellar payments:

- **Zero SDK integration**: Agents don't need to implement payment logic
- **Standardized interface**: Works with any MCP-compatible LLM client
- **Security by default**: Local execution, no secret exposure
- **Discovery built-in**: Provider registry integration
- **Mode selection automatic**: Best payment mode chosen automatically

This aligns with the RouteDock thesis: payment infrastructure should be invisible to agents, letting them focus on their core logic while payments happen seamlessly in the background.
