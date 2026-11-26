---
"@routedock/routedock": patch
"@routedock/mcp-server": patch
---

Check maxAmount against the payment manifest before reserving spend and against the unsigned x402 or MPP charge challenge before signing. Pass MCP max_amount directly to pay so provider repricing cannot bypass the per-call limit.
