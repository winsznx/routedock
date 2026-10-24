---
"@routedock/routedock": minor
---

Add `request` to `client.pay()` options and `SessionHandle.stream()` so POST endpoints can be paid: the caller's method, headers and body are replayed on the unpaid 402 probe, the paid request and every retry (bodies are buffered once for replay). SDK payment headers override caller headers, and the endpoint sunset check is now scoped to the request's HTTP method.
