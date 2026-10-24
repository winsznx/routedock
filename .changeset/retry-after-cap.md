---
"@routedock/routedock": patch
---

`withRetry` now caps every retry sleep at `maxDelayMs` (default 30s), including a server `Retry-After` hint. Previously a 429/503 carrying `Retry-After: 86400` made `pay()` and `fetchManifest()` sleep 24 hours before each retry. Hints below the cap are still honored exactly, `onRetry` receives the clamped delay, and the error's `retryAfterMs` still holds the raw server value.
