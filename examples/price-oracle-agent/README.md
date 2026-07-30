# price-oracle-agent

Fetches price quotes from Provider A using the **x402 one-shot payment** protocol. No channel setup required — each request pays for itself in a single on-chain settlement.

## What this covers

- `RouteDockClient.pay()` with `forceMode: 'x402'`
- The full x402 challenge-response flow: initial GET → 402 → sign → retry
- Reading `txHash` and `amount` from `PaymentResult`
- Local daily `spendCap` as a safety guardrail

## Setup

1. Install dependencies:

   ```bash
   pnpm install
   ```

2. Fund a Stellar testnet keypair via Friendbot:

   ```bash
   curl "https://friendbot.stellar.org?addr=G..."
   ```

3. Copy the env file and fill in your secret:

   ```bash
   cp .env.example .env
   ```

   ```env
   AGENT_SECRET=S...
   PROVIDER_A_URL=https://api-a.routedock.xyz
   STELLAR_NETWORK=testnet
   ```

## Run

```bash
pnpm start
```

## Expected output

```text
[client] network=testnet
[client] provider=https://api-a.routedock.xyz/price
[client] fetching 3 price quotes via x402

[RouteDock] Provider A → x402
#01 | pair=XLM/USDC  price=0.1042000  ts=2025-01-15T12:00:00.000Z  txHash=abc123…  paid=0.0010000 USDC
[RouteDock] Provider A → x402
#02 | pair=XLM/USDC  price=0.1041000  ts=2025-01-15T12:00:05.000Z  txHash=def456…  paid=0.0010000 USDC
[RouteDock] Provider A → x402
#03 | pair=XLM/USDC  price=0.1043000  ts=2025-01-15T12:00:10.000Z  txHash=ghi789…  paid=0.0010000 USDC

[done] fetched 3 quotes — each settled as a separate x402 transaction
```

Each `txHash` is a Stellar testnet transaction. Verify any of them at:

```text
https://stellar.expert/explorer/testnet/tx/<txHash>
```

## Key concepts

The x402 flow happens automatically inside `client.pay()`:

1. SDK sends `GET /price` with `X-Preferred-Mode: x402`.
2. Provider returns `402` with `X-Payment-Requirements` header.
3. SDK signs a payment payload using your `AGENT_SECRET` ed25519 key.
4. SDK retries with `payment-signature` header; provider settles on-chain.
5. `PaymentResult.txHash` contains the Stellar transaction hash.

To let the SDK auto-select the cheapest mode instead of forcing x402, remove the `forceMode` option from `client.pay()`.
