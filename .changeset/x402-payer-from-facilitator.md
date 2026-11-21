---
'@routedock/routedock': patch
---

x402 adapters (Express, Fastify, Hono) now pass `onSettled` the payer reported by the facilitator settle result (falling back to the verify result on the local path) instead of reading a nonexistent `authorization.credentials` field. A missing or invalid payer yields `null`.
