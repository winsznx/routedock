---
"@routedock/routedock": minor
---

`reconcileAbandonedSessions` no longer retries permanently failing closes forever. Failed closes now record `reconcile_attempts` and `last_reconcile_error` and move to the back of the queue; after `maxReconcileAttempts` (default 5) a session is set to the new terminal `failed` status. A "channel already closed" error now marks the session `closed` instead of retrying. `ReconciliationStats` gains `alreadyClosedCount` and `terminalCount`.
