---
"@routedock/routedock": minor
---

Add `RouteDockClient.getSpendStatus()`, which reports the asset, daily cap, spend so far today, remaining budget and per-endpoint caps from the spend store without making a payment. The read goes through the spend mutex, counts payments in flight, excludes rolled-back ones, and returns `null` caps when no `spendCap` is configured.
