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

2. Fund a Stellar testnet keypair via Friendbot:

   ```bash
   curl "https://friendbot.stellar.org?addr=G..."
   ```

3. Copy the env file:

   ```bash
   cp .env.example .env
   ```

   ```env
   AGENT_SECRET=S...
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

[RouteDock] Mock Inference Provider → mpp-charge
#01 prompt="hello"
     response="Hello! This response was paid for via MPP charge."
     model=mock-v1  txHash=abc123…  paid=0.0005000 USDC
  [provider] settled  txHash=abc123…  amount=0.0005000 USDC  mode=mpp-charge

[RouteDock] Mock Inference Provider → mpp-charge
#02 prompt="Can you explain what MPP charge is?"
     response="MPP (Metered Payment Protocol) charge enables per-request micropayments without a channel."
     model=mock-v1  txHash=def456…  paid=0.0005000 USDC
  [provider] settled  txHash=def456…  amount=0.0005000 USDC  mode=mpp-charge

[RouteDock] Mock Inference Provider → mpp-charge
#03 prompt="What is the capital of France?"
     response="I'm a mock inference endpoint. Payment received — here's your canned response."
     model=mock-v1  txHash=ghi789…  paid=0.0005000 USDC
  [provider] settled  txHash=ghi789…  amount=0.0005000 USDC  mode=mpp-charge

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
