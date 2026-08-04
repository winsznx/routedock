# MCP Server Setup Guide

Complete guide to set up and run the @routedock/mcp-server with Claude Desktop.

## Prerequisites

1. Node.js 20+ installed
2. A Stellar testnet account with XLM/USDC (for testing)
3. Claude Desktop installed

## Step 1: Build the MCP Server

```bash
cd /home/lynndabel/wokedi/routedock/packages/mcp-server
pnpm install
pnpm build
```

## Step 2: Generate Stellar Keys (if needed)

If you don't have a Stellar testnet account:

```bash
# Using stellar-sdk
node -e "const { Keypair } = require('@stellar/stellar-sdk'); const kp = Keypair.random(); console.log('Public Key:', kp.publicKey()); console.log('Secret Key:', kp.secret());"
```

Fund your testnet account at: https://friendbot.stellar.org/?address=<YOUR_PUBLIC_KEY>

## Step 3: Configure Environment Variables

Copy the example env file and fill in your credentials:

```bash
cp .env.example .env
```

Edit `.env` with your values:

```bash
STELLAR_SECRET=SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
STELLAR_NETWORK=testnet
COMMITMENT_SECRET=SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your-supabase-service-key
```

**Important:** 
- `STELLAR_SECRET` is required for all operations
- `COMMITMENT_SECRET` is only required for `open_session` (mpp-session mode)
- `SUPABASE_URL` and `SUPABASE_KEY` are only required for `list_providers`

## Step 4: Configure Claude Desktop

### macOS

Edit: `~/Library/Application Support/Claude/claude_desktop_config.json`

### Windows

Edit: `%APPDATA%\Claude\claude_desktop_config.json`

Add the following configuration:

```json
{
  "mcpServers": {
    "routedock": {
      "command": "node",
      "args": ["/home/lynndabel/wokedi/routedock/packages/mcp-server/dist/index.js"],
      "env": {
        "STELLAR_SECRET": "SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        "STELLAR_NETWORK": "testnet",
        "COMMITMENT_SECRET": "SXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        "SUPABASE_URL": "https://your-project.supabase.co",
        "SUPABASE_KEY": "your-supabase-service-key"
      }
    }
  }
}
```

**Note:** Replace the absolute path with your actual path to the built MCP server.

## Step 5: Restart Claude Desktop

Restart Claude Desktop to load the new MCP server configuration.

## Step 6: Test the MCP Server

In Claude Desktop, try these prompts:

### Check Balance
```
Check my Stellar balance
```

### List Providers
```
List available RouteDock providers on testnet
```

### Pay for Data
```
Pay for data from https://api-a.routedock.xyz/price with a max of 0.01 USDC
```

### Open Session (requires COMMITMENT_SECRET)
```
Open a session with https://api-b.routedock.xyz for streaming orderbook data
```

## Troubleshooting

### MCP Server Not Starting

Check Claude Desktop logs:
- macOS: `~/Library/Logs/Claude/`
- Windows: `%APPDATA%\Claude\logs\`

Common issues:
- Wrong absolute path to the built server
- Missing environment variables
- Node.js not in PATH

### Payment Failures

- Ensure your Stellar account has enough XLM for fees
- Ensure you have USDC balance on testnet
- Check that the provider URL is correct and accessible

### Session Mode Errors

- Ensure `COMMITMENT_SECRET` is set in your Claude config
- The commitment secret must be different from your wallet secret
- Generate a new Ed25519 keypair if needed

## Live Testnet Demo

The MCP server works with the live RouteDock testnet providers:

- **Provider A**: https://api-a.routedock.xyz (x402 + mpp-charge)
- **Provider B**: https://api-b.routedock.xyz (mpp-session)

Try paying for real data from these providers using the MCP tools!

## Security Notes

- **Never commit** your `.env` file or secrets to version control
- Use separate accounts for testnet and mainnet
- Keep your secret keys secure
- The MCP server runs locally - secrets are never sent to external servers

## Next Steps

1. Test all four MCP tools with the live providers
2. Integrate the MCP server into your agent workflows
3. Deploy your own RouteDock provider
4. Scale to mainnet when ready

See the main README.md for more information on RouteDock architecture and capabilities.
