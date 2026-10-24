---
"@routedock/routedock": patch
---

A failing `SeenTxStore.set` after on-chain settlement no longer turns a paid request into a 500. The x402 and mpp-charge handlers (Hono, Express and Fastify) now log the failure, report it through `onCallbackError(err, 'seenTxStore.set')`, and carry on to `onSettled` and the route, since the funds have already moved. A failed settle, a failed verify and a failed pre-settle `seenTxStore.get` behave as before.
