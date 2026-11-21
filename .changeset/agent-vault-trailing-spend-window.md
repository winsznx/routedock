---
"@routedock/routedock": patch
---

agent-vault: the daily cap and the per-payee sub-cap now bound spend in any trailing 17,280-ledger window instead of resetting on a fixed `ledger / 17_280` bucket. Previously the whole cap could be spent on the last ledger of a bucket and again on the first ledger of the next, so the real worst case was twice the configured cap. Counters are a ring of 25 sub-buckets of 720 ledgers (at most one sub-bucket of conservative over-counting). `payment_authorized.daily_cumulative` is now the spend in the trailing window. The counters use new storage keys, so a deployed vault picks this up through the timelocked upgrade and starts with an empty window.
