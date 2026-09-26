---
"@routedock/routedock": patch
"@routedock/nulth-sdk": patch
---

RouteDockClient.pay() with vault: { mode: 'nulth' } now rejects with RouteDockSignatureError because the x402 exact scheme can only attach ed25519 signatures, not Nulth ZK proofs. See https://github.com/winsznx/routedock/issues/356.
