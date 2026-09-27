# inference-agent

Sends prompts to a mock inference provider and pays per request using the **MPP charge** protocol. A mock Hono server starts in-process so the example runs without any external infrastructure.

## What this covers

- `RouteDockClient.pay()` with `forceMode: 'mpp-charge'`
- Building a RouteDock-compatible provider with `routedockHono` middleware
- `onSettled` callback for server-side payment logging
- Running provider and client in the same process for local demos

## Setup

1. Install dependencies:

   ```bash
   pnpm install
   ```

2. Fund Stellar testnet keypairs via Friendbot:

   ```bash
   curl "https://friendbot.stellar.org?addr=G<agent-pubkey>"
   curl "https://friendbot.stellar.org?addr=G<provider-pubkey>"
   ```

3. Add USDC trustline and get testnet USDC:

   `RouteDockClient.pay()` runs a trustline preflight and payments settle on-chain in USDC. Both accounts need a USDC trustline, and the agent (payer) needs testnet USDC:

   ```bash
   # Add trustline for agent (payer) and mock provider (receiver)
   stellar tx new --source <agent-key> --network testnet \
     change-trust --asset USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 --limit 100

   stellar tx new --source <provider-key> --network testnet \
     change-trust --asset USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 --limit 100

   # Get testnet USDC for the agent from Circle's testnet faucet:
   # https://faucet.circle.com/ (Select "Stellar Testnet", paste agent public key, request USDC)
   ```

   - **Agent (`AGENT_SECRET`, payer)**: needs testnet XLM, the USDC trustline, and testnet USDC.
   - **Provider (`PROVIDER_SECRET`, receiver)**: needs testnet XLM and the USDC trustline.

   > **Note:** `client.pay()` sends a `GET` request with no body, so a paid route must accept `GET` and read its input from the URL query string.

4. Copy the env file:

   ```bash
   cp .env.example .env
   ```

   ```env
   AGENT_SECRET=S...
   PROVIDER_SECRET=S...
   INFERENCE_PROVIDER_URL=http://localhost:3100
   START_MOCK_PROVIDER=true
   STELLAR_NETWORK=testnet
   ```

## Run

```bash
pnpm start
```

## Expected output

```text
[mock-provider] listening on http://localhost:3100
[client] network=testnet
[client] provider=http://localhost:3100/infer
[client] sending 3 inference requests via mpp-charge

#01 prompt="hello"
  [provider] settled  txHash=abc123…  amount=0.0005 USDC  mode=mpp-charge
     response="Hello! This response was paid for via MPP charge."
     model=mock-v1  txHash=abc123…  paid=0.0005 USDC

#02 prompt="Can you explain what MPP charge is?"
  [provider] settled  txHash=def456…  amount=0.0005 USDC  mode=mpp-charge
     response="MPP (Metered Payment Protocol) charge enables per-request micropayments without a channel."
     model=mock-v1  txHash=def456…  paid=0.0005 USDC

#03 prompt="What is the capital of France?"
  [provider] settled  txHash=ghi789…  amount=0.0005 USDC  mode=mpp-charge
     response="I'm a mock inference endpoint. Payment received — here's your canned response."
     model=mock-v1  txHash=ghi789…  paid=0.0005 USDC

[done] 3 inferences completed via mpp-charge
```

## Using a real provider

Set `START_MOCK_PROVIDER=false` and point `INFERENCE_PROVIDER_URL` at any RouteDock-compatible endpoint that supports `mpp-charge`:

```env
INFERENCE_PROVIDER_URL=https://your-inference-endpoint.example.com
START_MOCK_PROVIDER=false
```

## Key concepts

MPP charge differs from x402 in one important way: the provider pulls the payment from the payer's account rather than the payer pushing it. The SDK handles this automatically — `client.pay()` responds to the `402` challenge, authorises the charge, and the provider's `mppx` middleware settles it.

For high-frequency inference (hundreds of calls per session) consider switching to `mpp-session` to batch settlements into a single on-chain close — see the `streaming-orderbook-agent` example.
