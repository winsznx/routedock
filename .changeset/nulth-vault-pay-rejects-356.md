---
"@routedock/routedock": patch
"@routedock/nulth-sdk": patch
---

RouteDockClient.pay() with vault: { mode: 'nulth' } rejects with RouteDockSignatureError because the x402 exact scheme can only attach ed25519 signatures, not Nulth ZK proofs. The Nulth signing path is fail-closed with a clear error message linking to issue #356, the client-level test verifies the server receives only the manifest request, and the authorizeEntry test confirms the Nulth signer is rejected. See https://github.com/winsznx/routedock/issues/356.
