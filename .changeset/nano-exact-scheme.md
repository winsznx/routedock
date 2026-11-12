---
'@routedock/routedock': minor
---

Add an opt-in `exact` scheme on `nano:mainnet` to the provider exports: `createNanoExact` builds a per-order requirement and verifies a confirmed send block through a Nano node the operator configures. Each order commits to its id, payee and price in the block's representative field, and an accepted block hash is claimed in the supplied `SeenTxStore`, so a durable store refuses it again after a restart. Nothing changes for providers that do not call it.
