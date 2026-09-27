# agent-to-agent

An **orchestrator agent** breaks a document into chunks, then pays a **specialist sub-agent** to summarise each chunk using the x402 protocol. Both agents run in a single process for local demos.

## What this covers

- Agent-to-agent payments where the payer is itself an autonomous agent
- Building a specialist provider with `routedockHono` and a custom GET handler
- `RouteDockClient` on the orchestrator side paying another agent's endpoint
- Aggregating paid results into a final output
- Independent keypairs for orchestrator and specialist

## Setup

1. Install dependencies:

   ```bash
   pnpm install
   ```

2. Fund **two** Stellar testnet keypairs via Friendbot (one per agent):

   ```bash
   curl "https://friendbot.stellar.org?addr=G<orchestrator-pubkey>"
   curl "https://friendbot.stellar.org?addr=G<specialist-pubkey>"
   ```

3. Add USDC trustline and get testnet USDC:

   `RouteDockClient.pay()` runs a trustline preflight and payments settle on-chain in USDC. Both accounts need a USDC trustline, and the orchestrator (payer) needs testnet USDC:

   ```bash
   # Add trustline for orchestrator (payer) and specialist (receiver)
   stellar tx new --source <orchestrator-key> --network testnet \
     change-trust --asset USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 --limit 100

   stellar tx new --source <specialist-key> --network testnet \
     change-trust --asset USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 --limit 100

   # Get testnet USDC for the orchestrator from Circle's testnet faucet:
   # https://faucet.circle.com/ (Select "Stellar Testnet", paste orchestrator public key, request USDC)
   ```

   - **Orchestrator (`ORCHESTRATOR_SECRET`, payer)**: needs testnet XLM, the USDC trustline, and testnet USDC.
   - **Specialist (`SPECIALIST_SECRET`, receiver)**: needs testnet XLM and the USDC trustline.

   > **Note:** `client.pay()` sends a `GET` request with no body, so a paid route must accept `GET` and read its input from the URL query string.

4. Copy the env file:

   ```bash
   cp .env.example .env
   ```

   ```env
   ORCHESTRATOR_SECRET=S...
   SPECIALIST_SECRET=S...
   SPECIALIST_URL=http://localhost:3200
   START_MOCK_SPECIALIST=true
   STELLAR_NETWORK=testnet
   ```

## Run

```bash
pnpm start
```

## Expected output

```text
[specialist] listening on http://localhost:3200
[orchestrator] network=testnet
[orchestrator] specialist=http://localhost:3200/summarise
[orchestrator] summarising 3 document chunks

#01 input="Stellar is an open-source, decentralized payment protocol that…"
  [specialist] settled  txHash=abc123…  amount=0.0003 USDC  mode=x402
     Summary: "Stellar is an open-source, decentralized payment…"
     txHash=abc123…  paid=0.0003 USDC

#02 input="RouteDock is a payment middleware layer for AI agents, enablin…"
  [specialist] settled  txHash=def456…  amount=0.0003 USDC  mode=x402
     Summary: "RouteDock is a payment middleware layer…"
     txHash=def456…  paid=0.0003 USDC

#03 input="The x402 protocol extends HTTP with a 402 Payment Required flo…"
  [specialist] settled  txHash=ghi789…  amount=0.0003 USDC  mode=x402
     Summary: "The x402 protocol extends HTTP with…"
     txHash=ghi789…  paid=0.0003 USDC

--- Aggregated summaries ---
  1. Summary: "Stellar is an open-source, decentralized payment…"
  2. Summary: "RouteDock is a payment middleware layer…"
  3. Summary: "The x402 protocol extends HTTP with…"

[orchestrator] total paid to specialist: 0.0009 USDC
[done] agent-to-agent task complete
```

## Architecture

```
Orchestrator Agent                 Specialist Sub-Agent
  RouteDockClient ──── x402 ───────► routedockHono middleware
  (ORCHESTRATOR_SECRET)              └─ GET /summarise handler
                                     (SPECIALIST_SECRET)
```

Each agent has its own funded Stellar keypair. The orchestrator's wallet is debited; the specialist's wallet is credited on every settled x402 transaction.

## Extending this pattern

- Replace the canned summariser with a real LLM call inside the specialist's `GET /summarise` handler.
- Add more specialist agents (e.g., `/translate`, `/classify`) — the orchestrator calls each one independently.
- Switch to `mpp-session` if the orchestrator needs to stream many sub-results from a single specialist — see `streaming-orderbook-agent` for the session pattern.
- Deploy orchestrator and specialist as separate services. The only change needed is setting `SPECIALIST_URL` to the specialist's public URL and `START_MOCK_SPECIALIST=false`.
