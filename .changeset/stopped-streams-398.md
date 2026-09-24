---
"@routedock/routedock": patch
---

Stop `MppSessionClient.stream()` from signing new vouchers once the session is closed. The `closed` flag was only read by the `maxDurationMs` lifetime guard, so a consumer that kept iterating an active stream still ran the spend check and issued ever-higher cumulative vouchers after `close()` (or after the guard fired). Both the sequential and pipelined loops now check it before issuing a voucher — including before refilling the pipelined window — and end the iterator with `RouteDockChannelStateError` (`session closed`).
