# @routedock/nulth-sdk

## 0.2.0

### Minor Changes

- [#180](https://github.com/winsznx/routedock/pull/180) [`4da4b78`](https://github.com/winsznx/routedock/commit/4da4b78729b0a31866cef1c99539f54152734293) Thanks [@Jaydearcadian](https://github.com/Jaydearcadian)! - Restore the public npm release pipeline, build every publishable package before publication, and prepare the RouteDock packages for their 0.2.0 releases.

### Patch Changes

- [#469](https://github.com/winsznx/routedock/pull/469) [`34a1a79`](https://github.com/winsznx/routedock/commit/34a1a7961b9aa61a006a654ea8c1835b0529002e) Thanks [@joydeelish](https://github.com/joydeelish)! - Point the require condition in exports at the emitted .d.cts declarations so CJS consumers on node16/nodenext get CJS types.

- [#441](https://github.com/winsznx/routedock/pull/441) [`98fc671`](https://github.com/winsznx/routedock/commit/98fc671b25d858010a5bc52c451b936852028be7) Thanks [@Yerimahjr](https://github.com/Yerimahjr)! - Nulth signers now decode the Soroban auth entry before signing and reject it with `NulthPolicyError` code `auth_entry_mismatch` unless it is a single `transfer` on `assetContract` from the Nulth account to `paymentContext.payee` for exactly `paymentContext.amountStroops`, with no sub-invocations. `assertAuthEntryMatchesContext` is exported from `@routedock/nulth-sdk`.

- [#480](https://github.com/winsznx/routedock/pull/480) [`b9d8b7e`](https://github.com/winsznx/routedock/commit/b9d8b7ef84f9cf3b484efc4b56d06de93dd193be) Thanks [@Mayor-Isaac](https://github.com/Mayor-Isaac)! - Make the Nulth mainnet guard fail closed. `NulthClient` construction now throws unless `network` is `'testnet'`, and throws on any prover other than `'mock'`, so a missing or misspelled network (for example `'pubnet'`), a network read from env or JSON, or a legacy `prover: 'wasm'` setting can no longer produce a mock-proof client on a non-testnet network.

- [#467](https://github.com/winsznx/routedock/pull/467) [`155e610`](https://github.com/winsznx/routedock/commit/155e610d1a2cd0a8419b3169e484183a342dd666) Thanks [@joydeelish](https://github.com/joydeelish)! - Publish only dist/ and README.md from each package.

- [#237](https://github.com/winsznx/routedock/pull/237) [`2eac983`](https://github.com/winsznx/routedock/commit/2eac983f738b83fecbc259b94e55d27c4b9dd7d7) Thanks [@TS-mfon](https://github.com/TS-mfon)! - Block the insecure Nulth mock prover on mainnet and stop advertising an unimplemented WASM backend.
