---
"@routedock/routedock": patch
---

Session vouchers are now signed once per item. A retried voucher request replays the credential it already signed instead of answering a fresh 402 with a higher cumulative, and a fresh 402 on the replay surfaces as `RouteDockChannelStateError`. The local spend cap is charged at the point of signing, so a request that fails before a voucher is signed no longer burns cap, and `stats().vouchersIssued` always matches `currentCumulative / rate`.
