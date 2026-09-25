---
'@routedock/nulth-sdk': patch
'@routedock/routedock': patch
---

Verify the Soroban auth entry matches the payment context (function name and sub-invocations) before signing, exposing `assertAuthEntryMatchesContext` and a new `NulthPolicyError` code for the mismatch.
