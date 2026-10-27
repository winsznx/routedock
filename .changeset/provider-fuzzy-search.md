---
"@routedock/routedock": minor
"@routedock/mcp-server": minor
---

Provider discovery can now search by free-text capability. `ProviderRegistry.searchProviders(query, { limit?, includeUnverified? })` calls a new `search_providers` SQL function (migration `007_search_providers.sql`) that ranks providers by trigram similarity of name and description and boosts exact tag matches, and falls back to the on-chain registry when Supabase is unavailable. The MCP `list_providers` tool takes an optional `query` argument that uses the same function; `tags` and `network` behave as before when `query` is absent.
