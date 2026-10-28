---
'@routedock/mcp-server': patch
---

`check_balance` no longer lets an asset code pick the balance: with `asset_issuer` omitted, `USDC` is matched to the canonical Circle issuer for the configured network (same-coded assets from other issuers are ignored), and any other code held from several issuers is returned as `ambiguous` with every `{ issuer, balance }` pair instead of whichever one Horizon listed first. The issuer table is read from the shared `@routedock/routedock/network` entry, so the MCP server and the SDK's trustline preflight keep one source of truth for Circle's issuers.
