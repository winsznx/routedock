---
'@routedock/nulth-sdk': patch
'@routedock/routedock': patch
---

Nulth signer now refuses auth entries whose `signatureExpirationLedger` is outside the session policy (`auth_expiry_out_of_policy`), and `NulthStellarScheme` clamps provider `maxTimeoutSeconds` to 300.
