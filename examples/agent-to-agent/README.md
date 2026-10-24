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

3. Add USDC trustlines to both agents and fund the payer. Replace each `<..._KEY>` placeholder with the corresponding Stellar CLI signing-key alias:

   ```bash
   stellar tx new change-trust --source-account <ORCHESTRATOR_KEY> --network testnet \
     --line USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5

   stellar tx new change-trust --source-account <SPECIALIST_KEY> --network testnet \
     --line USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
   ```

   `--limit` is left out on purpose: it is in stroops and defaults to the maximum, so a value like `--limit 100` would cap the trustline at 0.00001 USDC. The specialist needs the trustline to receive x402 transfers. Then open [Circle's testnet faucet](https://faucet.circle.com/), select **Stellar Testnet**, paste the orchestrator public key, and request spendable testnet USDC for the payer.

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
[RouteDock] Using in-memory SpendStore: the daily spend cap is NOT durable and resets on every process restart. Inject a persistent SpendStore via RouteDockClientConfig.spendStore for production safety.
[orchestrator] network=testnet
[orchestrator] specialist=http://localhost:3200/summarise
[orchestrator] summarising 3 document chunks

#01 input="Stellar is an open-source, decentralized payment protocol th…"
  [specialist] settled  txHash=6a95d269a8939705e607077cbda333c92d49893ff3a1c828a55779c48f7fa96a  amount=0.0003 USDC  mode=x402
     Summary: "Stellar is an open-source, decentralized payment…"
     txHash=6a95d269a8939705e607077cbda333c92d49893ff3a1c828a55779c48f7fa96a  paid=0.0003 USDC

#02 input="RouteDock is a payment middleware layer for AI agents, enabl…"
  [specialist] settled  txHash=9d46d11206d124e4ab280282ec0f92406db7028193e2725ee45175067495d809  amount=0.0003 USDC  mode=x402
     Summary: "RouteDock is a payment middleware layer…"
     txHash=9d46d11206d124e4ab280282ec0f92406db7028193e2725ee45175067495d809  paid=0.0003 USDC

#03 input="The x402 protocol extends HTTP with a 402 Payment Required f…"
  [specialist] settled  txHash=53bb5d69eb1576392d1e2da9e3773cb9deac42494089ab756b165e13c62befa7  amount=0.0003 USDC  mode=x402
     Summary: "The x402 protocol extends HTTP with…"
     txHash=53bb5d69eb1576392d1e2da9e3773cb9deac42494089ab756b165e13c62befa7  paid=0.0003 USDC

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
- Deploy orchestrator and specialist as separate services. Set `SPECIALIST_URL` to the specialist's public base URL and `START_MOCK_SPECIALIST=false` in the orchestrator environment.
