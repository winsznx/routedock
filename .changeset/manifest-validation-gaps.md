---
"@routedock/routedock": patch
---

Malformed provider manifests are now refused with typed errors at fetch/preflight time instead of a raw `TypeError`, `Error` or `RangeError` later in `pay()` or `estimateCost()`. `assertManifestValid` now also requires a `pricing` entry for every mode in `modes`, requires every `deprecated_modes` entry to be in `modes`, and checks that every `amount`, `rate` and `min_deposit` is a valid decimal (at most 7 fractional digits). `routedock.schema.json` now enforces Stellar address patterns on `payee`, `pricing.*.payee`, `asset_contract` and `channel_factory`, and a decimal pattern on prices. `verifyManifestSignature` throws `RouteDockSignatureError` for a malformed `payee` instead of a bare `Error`. Providers whose manifests used placeholder addresses or amounts will now be rejected by clients.
