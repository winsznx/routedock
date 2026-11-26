---
'@routedock/routedock': patch
---

mpp-session now prunes `stellar:channel:challenge:*` replay keys from the session store after `challengeRetentionMs` (default 10 minutes), so long-running providers no longer leak one key per voucher. provider-b also sweeps stale challenge keys with a Durable Object alarm.
