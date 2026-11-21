---
"@routedock/routedock": patch
"@routedock/mcp-server": patch
---

Bind the caller's maxAmount ceiling to the actual payment manifest and unsigned x402 or MPP charge challenge before reserving spend or signing. Pass MCP max_amount directly to pay so provider repricing cannot bypass the per-call limit.
