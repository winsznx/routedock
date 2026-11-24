---
'@routedock/routedock': minor
---

`pay()` and `estimateCost()` now throw `RouteDockManifestError` when the manifest declares the request path but not the request method, before mode selection and signing (#761). Previously the client signed a payment for a method the manifest never advertised, which a payment middleware would settle before the route answered 404.

The `agent-to-agent` and `inference-agent` examples are fixed accordingly: the manifest declares `POST`, the mock servers register POST routes and read the JSON body the client sends, and both export their app builders (`main()` only runs when the file is executed directly) so a new CI route test can exercise them without funds.
