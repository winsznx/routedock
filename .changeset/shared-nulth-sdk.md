---
"@routedock/nulth-sdk": patch
"@routedock/routedock": patch
---

Use the shared Nulth client, proof and signer implementation in RouteDock while
preserving manifest errors and configurable SDK logging. Add typed Nulth
configuration errors and an optional logger with a silent standalone default.
