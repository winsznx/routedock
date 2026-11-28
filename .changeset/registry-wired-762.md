---
'@routedock/routedock': minor
'@routedock/mcp-server': minor
---

Wire `ProviderRegistry` into the MCP server and fix its correctness gaps (#762).

- `ProviderRegistry.listProviders()` queries Supabase and the on-chain registry and merges by normalized origin (Supabase metadata wins), instead of using on-chain only when Supabase is empty. Supabase rows are ordered by `registered_at` with a configurable `limit`, and query failures go to an optional `logger`.
- `deriveNetwork` / `onChain.network`: only the two public Horizon hosts are inferred; any other Horizon URL must pass `network` instead of silently becoming mainnet.
- On-chain tags keep only string entries. New `registerOnChain({ secret, endpoint, tags, network })` writes the data entries and refuses values over Stellar's 64-byte limit. `ProviderRecord` gains an optional `assets`.
- `listProviders({ includeUnverified, tags })`: by default only operator-verified Supabase rows are returned; `includeUnverified` also returns self-registered rows flagged `verified: false` (ordered verified first, then `last_seen_at`), and `tags` filters inside the Supabase query, before the row limit.
- `estimateCost`, `pay` and `openSession` accept a per-call `expectedPayee` that overrides the client-wide one (#729), so one agent can bind each provider to its own payee and the payment itself rejects a manifest signed by another key.
- MCP `list_providers` is backed by the registry (set `ROUTEDOCK_REGISTRY_ACCOUNTS`, with or without Supabase), keeps unverified providers in the listing (flagged `verified: false`) and returns each provider's `payee` and `source`.
- MCP `pay_for_data` and `open_session` pass the registered payee of a verified, registry-listed origin as the per-call `expectedPayee`, so a manifest signed by a different payee is rejected with `RouteDockSignatureError` before anything is paid or signed, even if the provider serves different manifests per request. Registry lookups are cached for 30 seconds.
