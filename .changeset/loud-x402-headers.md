---
"@routedock/routedock": patch
---

Reject a malformed `X-Payment-Requirements` header on a 402 response with a typed `RouteDockManifestError` instead of leaking the decoder's raw `Error` or `SyntaxError`.
