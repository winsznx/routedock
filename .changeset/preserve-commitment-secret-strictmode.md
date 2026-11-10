---
"@routedock/routedock": patch
---

Preserve `commitmentSecret` in `useRouteDockClient` under React StrictMode by only disposing the previous client instance when a config change replaces it.
