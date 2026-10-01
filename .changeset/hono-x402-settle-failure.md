---
"@routedock/routedock": patch
---

Fail closed when an x402 facilitator reports a failed settlement. A settle result now counts as successful only when it returns `success: true` with a non-empty transaction hash; a `{ success: false, errorReason }` result (or `success: true` with an empty transaction) returns 402 carrying the payment requirements header instead of serving the resource. The failed branch never writes the idempotency record, never fires `onSettled`, and never reaches the protected route, and the Hono adapter and the shared Express/Fastify x402 handler use the same check so they cannot drift.
