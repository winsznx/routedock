---
"@routedock/routedock": patch
"@routedock/nulth-sdk": patch
---

Fix paymentContextFromManifest to use per-mode payee override (pricing.<mode>.payee) when set, falling back to manifest.payee.
