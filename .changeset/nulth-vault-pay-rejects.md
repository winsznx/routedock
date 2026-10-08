---
"@routedock/nulth-sdk": patch
"@routedock/routedock": patch
---

RouteDockClient.pay() now rejects Nulth vaults with a clear `RouteDockSignatureError` before any network request is made (only the manifest fetch occurs). The `authorizeEntry` flow also fails closed when a Nulth signer is used, since Nulth returns ZK proof bytes instead of ed25519 signatures.