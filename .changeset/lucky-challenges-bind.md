---
"@routedock/routedock": patch
"@routedock/nulth-sdk": patch
---

Bind the payment challenge to the signed manifest before anything is signed. The client verified the manifest signature and then signed whatever the unsigned 402 asked for, so a dishonest provider could publish a manifest priced at 0.0001 USDC and demand 1000 USDC to any address in any SAC token. `X402Client` and `MppChargeClient` now compare the challenge's network, payee, asset and amount against the manifest and throw `RouteDockPolicyRejectError` with a `challenge_*` reason before any signer is called. `PaymentResult.amount` reports the amount actually signed, which may be less than the manifest price, and `stroopsToUsdc` is exported from `@routedock/nulth-sdk` as the inverse of `usdcToStroops`.
