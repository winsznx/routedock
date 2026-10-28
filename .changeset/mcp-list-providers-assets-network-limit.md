---
'@routedock/mcp-server': patch
---

`list_providers` now returns the assets a provider actually accepts (projected from the registry's `manifest` JSONB, where `asset` used to come out `undefined`) together with its `verified` flag, scopes the query to the server's own `STELLAR_NETWORK` unless the caller names one, and bounds the result set to 50 rows with an optional `limit` argument, ordered verified-first then newest registration.
