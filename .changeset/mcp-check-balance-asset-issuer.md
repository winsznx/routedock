---
'@routedock/mcp-server': patch
'@routedock/routedock': patch
---

`check_balance` no longer lets an asset code pick the balance: with `asset_issuer` omitted, `USDC` is matched to the canonical Circle issuer for the configured network (same-coded assets from other issuers are ignored), and any other code held from several issuers is returned as `ambiguous` with every `{ issuer, balance }` pair instead of whichever one Horizon listed first. The SDK now exports `USDC_ISSUERS`, so the MCP server reads Circle's issuers from the same source of truth as the trustline preflight.
