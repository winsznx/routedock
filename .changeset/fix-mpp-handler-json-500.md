---
"@routedock/routedock": patch
---

Hono `mpp-charge` and `mpp-session` / `mpp-session-ws` handlers now log unexpected errors through the configured `logger` and return a JSON `{ error }` 500, matching the x402 handler, instead of rethrowing to Hono's plain-text default error handler. `RouteDockManifestError` is still rethrown, and a failed `channelClose` on DELETE is now caught as well.
