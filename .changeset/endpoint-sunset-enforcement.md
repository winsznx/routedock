---
"@routedock/routedock": minor
---

Enforce the per-endpoint `deprecated` and `sunset_at` metadata. `pay()`, `estimateCost()` and `openSession()` now refuse a URL whose matching endpoint descriptor has passed its `sunset_at` with a `RouteDockManifestSunsetError`, and log a `[RouteDock] WARNING:` line before paying a deprecated endpoint.
