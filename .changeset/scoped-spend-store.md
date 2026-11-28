---
'@routedock/routedock': minor
---

Scope the local spend accumulator by network, wallet and asset, and expand `~` in `FileSpendStore` paths (#763).

- `RouteDockClient` now passes a scope (`${network}:${walletPublicKey}:${asset}`) to `SpendStore.read`/`write`/`update`. `FileSpendStore` stores one accumulator per scope (`{ version: 2, scopes }`), so clients on different networks or wallets can share one file without sharing a cap. `SpendStore` gains an optional `scope` argument, so custom stores keep compiling; a store that ignores it pools all clients into one cap.
- `FileSpendStore` validates every scope record, and a legacy single record, with the #760 validators and throws `RouteDockPolicyRejectError('local_spend_state_invalid')` for a malformed one (negative or non-integer total, bad date) instead of resetting the cap. `getSpendStatus()` reads the client's scope.
- A pre-scope spend file is adopted by the first scope that reads it, so today's total is not lost, and a one-time info line is logged.
- `new FileSpendStore('~/…')` expands a leading `~` with `os.homedir()` and resolves to an absolute path, exposed as `filePath`. Previously the file landed in a directory literally named `~` under the working directory.
- Exports `spendScopeKey` and `resolveSpendFilePath`.
