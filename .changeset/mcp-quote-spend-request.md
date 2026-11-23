---
"@routedock/mcp-server": minor
---

Add `quote_provider` (per-mode prices and compliance flags without paying) and `get_spend_status` (daily cap usage). `pay_for_data` now accepts optional `method`, `headers` and `body` (max 64 KiB) so POST providers can be paid; `Authorization` and `x-payment*` headers are rejected. Every tool now carries MCP `annotations`: the read-only tools are marked `readOnlyHint`, and the four spending tools are marked destructive, non-idempotent and open-world.
