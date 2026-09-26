---
"@routedock/routedock": patch
---

Normalize `spendCap.endpointCaps` keys to their URL origin in `RouteDockClient`, so a trailing slash, uppercase host, or explicit default port no longer silently disables that endpoint's cap. A key that isn't a valid URL, includes a path/query/hash, or normalizes to the same origin as another key now throws a `RouteDockManifestError` at construction instead of the cap being dropped without warning.
