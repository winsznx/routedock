---
"@routedock/routedock": patch
---

Run the nulth vault path through the local spend reservation. `RouteDockClient.pay()` returned into `_payWithNulthVault()` before `_checkAndReserveSpend()`, so `spendCap.daily` and `spendCap.endpointCaps` did not apply to vault payments and vault spend was never recorded for later payments. The reservation is now taken before either mode dispatches, inside the same `try` block, so it commits on success and rolls back on failure — including the vault mode/prover validation errors that previously escaped unaccounted.
