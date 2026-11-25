---
'@routedock/routedock': patch
---

Validate spend-cap state read from a `SpendStore`. A record that is `null`-shaped, `{}`, an array, or has a missing, non-string, non-integer or negative `totalMicros`/endpoint total now rejects the payment with `RouteDockPolicyRejectError('local_spend_state_invalid')` instead of resetting the cap or raising its headroom, and `FileSpendStore` fails closed on wrong-shape files (left untouched). Rollbacks clamp at zero and log a warning.
