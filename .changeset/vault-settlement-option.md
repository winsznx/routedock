---
"@routedock/routedock": minor
---

Record `session_settled` on the agent vault from every adapter, and stop reading `process.env` inside the provider handlers.

The Hono adapter never recorded vault settlements at all — only the Express path did, reading the process-wide `AGENT_VAULT_CONTRACT` env var (unavailable on Workers without `nodejs_compat`), hardcoding the RPC URL, and silently ignoring `sendTransaction` results. All adapters (`routedock`, `routedockFastify`, `routedockHono`) now accept an explicit `vaultSettlement?: { contract: string; rpcUrl?: string }` option and share one `recordSessionSettlement` helper that builds, prepares, signs, sends, and polls the transaction until it is included or fails. Every failure is logged with the transaction hash and reason and reported through `onCallbackError`, and can never throw into the channel-close response. `routedockHono` also accepts `waitUntil` so Workers can keep the isolate alive for the settlement record; without it the record runs as a background promise.

For one release, adapters fall back to the `AGENT_VAULT_CONTRACT` and `AGENT_VAULT_CONTRACT_ID` environment variables when the option is unset, with a deprecation warning — the option wins. The docs have always told operators to set `AGENT_VAULT_CONTRACT_ID`, which no SDK code read; provider-b now reads that same variable.
