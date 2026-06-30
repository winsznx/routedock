# agent-to-agent

An **orchestrator agent** breaks a document into chunks, then pays a **specialist sub-agent** to summarise each chunk using the x402 protocol. Both agents run in a single process for local demos.

## What this covers

- Agent-to-agent payments where the payer is itself an autonomous agent
- Building a specialist provider with `routedockHono` and a custom POST handler
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

3. Copy the env file:

   ```bash
   cp .env.example .env
   ```

   ```env
   ORCHESTRATOR_SECRET=S...
   SPECIALIST_SECRET=S...
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

[RouteDock] Summariser Specialist → x402
#01 input="Stellar is an open-source, decentralized payment protoc…"
     Summary: "Stellar is an open-source, decentralized payment…"
     txHash=abc123…  paid=0.0003000 USDC

[RouteDock] Summariser Specialist → x402
#02 input="RouteDock is a payment middleware layer for AI agents…"
     Summary: "RouteDock is a payment middleware layer…"
     txHash=def456…  paid=0.0003000 USDC

[RouteDock] Summariser Specialist → x402
#03 input="The x402 protocol extends HTTP with a 402 Payment Req…"
     Summary: "The x402 protocol extends HTTP with…"
     txHash=ghi789…  paid=0.0003000 USDC

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
  RouteDockClient ──── x402 ──────► routedockHono middleware
  (ORCHESTRATOR_SECRET)              ► POST /summarise handler
                                     (SPECIALIST_SECRET)
```

Each agent has its own funded Stellar keypair. The orchestrator's wallet is debited; the specialist's wallet is credited on every settled x402 transaction.

## Extending this pattern

- Replace the canned summariser with a real LLM call inside the specialist's `POST /summarise` handler.
- Add more specialist agents (e.g., `/translate`, `/classify`) — the orchestrator calls each one independently.
- Switch to `mpp-session` if the orchestrator needs to stream many sub-results from a single specialist — see `streaming-orderbook-agent` for the session pattern.
- Deploy orchestrator and specialist as separate services. The only change needed is setting `INFERENCE_PROVIDER_URL` to the specialist's public URL and `START_MOCK_SPECIALIST=false`.
