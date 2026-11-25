---
'@routedock/routedock': patch
---

Fix Express provider handlers resolving endpoint-scoped assets from the mount-relative `req.path`, which made middleware mounted with `app.use('/path', routedock(...))` charge an unscoped asset or fail with "No eligible assets". The x402 and mpp-charge handlers now use the full request path (and the same path for idempotency), matching the Hono and Fastify adapters.
