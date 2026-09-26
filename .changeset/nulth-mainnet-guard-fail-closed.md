---
'@routedock/nulth-sdk': patch
'@routedock/routedock': patch
---

Make the Nulth mainnet guard fail closed. `NulthClient` construction now throws unless `network` is `'testnet'`, and throws on any prover other than `'mock'`, so a missing or misspelled network (for example `'pubnet'`), a network read from env or JSON, or a legacy `prover: 'wasm'` setting can no longer produce a mock-proof client on a non-testnet network.
