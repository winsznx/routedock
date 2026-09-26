# @routedock/routedock

## 0.2.0

### Minor Changes

- [#180](https://github.com/winsznx/routedock/pull/180) [`4da4b78`](https://github.com/winsznx/routedock/commit/4da4b78729b0a31866cef1c99539f54152734293) Thanks [@Jaydearcadian](https://github.com/Jaydearcadian)! - Restore the public npm release pipeline, build every publishable package before publication, and prepare the RouteDock packages for their 0.2.0 releases.

- [#181](https://github.com/winsznx/routedock/pull/181) [`e0eea65`](https://github.com/winsznx/routedock/commit/e0eea652e4893373e147f785344987e19f66cac6) Thanks [@Jaydearcadian](https://github.com/Jaydearcadian)! - Enforce manifest and payment-mode deprecation, reject sunset manifests including cached entries, and expose per-endpoint deprecation metadata.

- [#477](https://github.com/winsznx/routedock/pull/477) [`772106d`](https://github.com/winsznx/routedock/commit/772106de701d782447df93a0c017699b41f1bf15) Thanks [@Mayor-Isaac](https://github.com/Mayor-Isaac)! - Enforce the per-endpoint `deprecated` and `sunset_at` metadata. `pay()`, `estimateCost()` and `openSession()` now refuse a URL whose matching endpoint descriptor has passed its `sunset_at` with a `RouteDockManifestSunsetError`, and log a `[RouteDock] WARNING:` line before paying a deprecated endpoint.

- [#240](https://github.com/winsznx/routedock/pull/240) [`5c6b01f`](https://github.com/winsznx/routedock/commit/5c6b01ff33117688f65ef3bcc1d6e40e20a4e7d8) Thanks [@chiomailekuba](https://github.com/chiomailekuba)! - Secure manifest signatures with versioned recursive canonicalization so nested pricing, endpoint, channel, SLA, and capability fields cannot be modified without invalidating the signature.

- [#439](https://github.com/winsznx/routedock/pull/439) [`28716eb`](https://github.com/winsznx/routedock/commit/28716eb373d9a575b7e8b1f650b532373cfccd20) Thanks [@Cerome360](https://github.com/Cerome360)! - Validate every `mpp-session` / `mpp-session-ws` 402 challenge against the signed manifest before anything is signed. The provider authors the challenge and the channel client signed its `cumulativeAmount` verbatim, so one voucher could commit the whole channel deposit (and the daily cap, which reserves `pricing.rate`, never saw it). Challenges are now rejected with `RouteDockChannelStateError` when they name a different channel than `channel_factory`, when `request.amount` differs from `pricing.rate`, or when `methodDetails.cumulativeAmount` is malformed or above the locally reserved baseline; the signed value is always the client's own arithmetic. New `SessionOptions.store` (an mppx `Store`) seeds that baseline across sessions — without one, a session fails closed on a challenge reporting a non-zero cumulative instead of trusting it.

- [#449](https://github.com/winsznx/routedock/pull/449) [`f36fd32`](https://github.com/winsznx/routedock/commit/f36fd329e4cfaaf73466b5e501f2c2e8325c253c) Thanks [@TS-mfon](https://github.com/TS-mfon)! - SupabaseSessionStore now writes channel_contract and network, which fixes the NOT NULL failure on every upsert. SessionState gains two required fields, channel_contract and network. SessionStore gains setStatus(channelId, status, settlementTxHash?) for status changes that must not touch cumulative_amount, and close() now delegates to it.

- [#231](https://github.com/winsznx/routedock/pull/231) [`291afa5`](https://github.com/winsznx/routedock/commit/291afa5a1f443136a62f59eea360ac35f6191d4b) Thanks [@melanindebbie](https://github.com/melanindebbie)! - Respect `Cache-Control: max-age` / `Expires` response headers for per-entry manifest cache TTL, and expose `RouteDockClient.invalidateManifest(url)` for explicit eviction so provider manifest updates take effect before the default TTL expires.

- [#227](https://github.com/winsznx/routedock/pull/227) [`d291a14`](https://github.com/winsznx/routedock/commit/d291a14ef40faa9daca60d514569a4abc4d26a64) Thanks [@melanindebbie](https://github.com/melanindebbie)! - Add `mpp-session-ws`: a WebSocket transport variant of `mpp-session` that opens the channel, negotiates the voucher over HTTP, then upgrades the connection to WebSocket for push-based streaming from inference providers. Includes Hono provider support (shared channel store across both session transports), manifest schema, and mode selection via a `transport: 'websocket'` option.

- [#437](https://github.com/winsznx/routedock/pull/437) [`527ab9a`](https://github.com/winsznx/routedock/commit/527ab9a55cbc48671b8f71fe0e3a69f90a0adcbd) Thanks [@Cerome360](https://github.com/Cerome360)! - Emit `session:close-failed` when the `maxDurationMs` auto-close rejects, carrying the rejection and the elapsed budget, and report it through `console.warn`. Previously the failure was swallowed with no event and no log, so a caller could not tell that the channel collateral was still locked. `SessionHandle.on()` now narrows listener payloads per event through `SessionEventPayloadMap`.

### Patch Changes

- [#241](https://github.com/winsznx/routedock/pull/241) [`d9ac7f4`](https://github.com/winsznx/routedock/commit/d9ac7f4fbf095f47acb2b9d9fc305f4157b12ee3) Thanks [@chiomailekuba](https://github.com/chiomailekuba)! - Preserve typed Stellar MPP channel verification failures and make provider-side channel envelope authorization explicit during close and recovery operations.

- [#452](https://github.com/winsznx/routedock/pull/452) [`8a69faf`](https://github.com/winsznx/routedock/commit/8a69faf805c9638fba44350913d43d85940f500f) Thanks [@Times-stack](https://github.com/Times-stack)! - Normalize `spendCap.endpointCaps` keys to their URL origin in `RouteDockClient`, so a trailing slash, uppercase host, or explicit default port no longer silently disables that endpoint's cap. A key that isn't a valid URL, includes a path/query/hash, or normalizes to the same origin as another key now throws a `RouteDockManifestError` at construction instead of the cap being dropped without warning.

- [#480](https://github.com/winsznx/routedock/pull/480) [`b9d8b7e`](https://github.com/winsznx/routedock/commit/b9d8b7ef84f9cf3b484efc4b56d06de93dd193be) Thanks [@Mayor-Isaac](https://github.com/Mayor-Isaac)! - Make the Nulth mainnet guard fail closed. `NulthClient` construction now throws unless `network` is `'testnet'`, and throws on any prover other than `'mock'`, so a missing or misspelled network (for example `'pubnet'`), a network read from env or JSON, or a legacy `prover: 'wasm'` setting can no longer produce a mock-proof client on a non-testnet network.

- [#447](https://github.com/winsznx/routedock/pull/447) [`e22f931`](https://github.com/winsznx/routedock/commit/e22f9314e9176eee5452cf7eb6ae2fafbba00760) Thanks [@simonpeters298](https://github.com/simonpeters298)! - Honor `OnChainRegistry`'s `timeoutMs` so a stalled Horizon no longer hangs `listProviders()` indefinitely: account loads now time out, run concurrently, and clear their timers on every path. `ProviderRegistryConfig.onChain` gains an optional `timeoutMs` (default 10000 ms per account) that is forwarded to the registry.

- [#260](https://github.com/winsznx/routedock/pull/260) [`e571dd4`](https://github.com/winsznx/routedock/commit/e571dd4f0b6b4f9058235eca0bb0d5ecf262e047) Thanks [@Olalolo22](https://github.com/Olalolo22)! - Add registerProvider helper to verify manifest signature and upsert into Supabase provider registry on startup.

- [#237](https://github.com/winsznx/routedock/pull/237) [`2eac983`](https://github.com/winsznx/routedock/commit/2eac983f738b83fecbc259b94e55d27c4b9dd7d7) Thanks [@TS-mfon](https://github.com/TS-mfon)! - Block the insecure Nulth mock prover on mainnet and stop advertising an unimplemented WASM backend.

- [#261](https://github.com/winsznx/routedock/pull/261) [`890c491`](https://github.com/winsznx/routedock/commit/890c4918567a1124569fd99246d4983142f440fd) Thanks [@Olalolo22](https://github.com/Olalolo22)! - Export SessionReconciler helpers and types from the SDK and provider hono entrypoints for automated session reconciliation.

- [#443](https://github.com/winsznx/routedock/pull/443) [`8b9b431`](https://github.com/winsznx/routedock/commit/8b9b431edd705c3ecc704f701fd11b109e8a18cb) Thanks [@Yerimahjr](https://github.com/Yerimahjr)! - Honor `Cache-Control: no-store` and `no-cache` in the manifest cache so those responses are never reused.

- [#440](https://github.com/winsznx/routedock/pull/440) [`69bd6bf`](https://github.com/winsznx/routedock/commit/69bd6bfb920e6e9aaea23259fb1d9e3c07e3b4d1) Thanks [@TS-mfon](https://github.com/TS-mfon)! - Trustline preflight now requires the expected USDC issuer, and the testnet USDC issuer is corrected to GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5.

- Updated dependencies [[`4da4b78`](https://github.com/winsznx/routedock/commit/4da4b78729b0a31866cef1c99539f54152734293), [`b9d8b7e`](https://github.com/winsznx/routedock/commit/b9d8b7ef84f9cf3b484efc4b56d06de93dd193be), [`2eac983`](https://github.com/winsznx/routedock/commit/2eac983f738b83fecbc259b94e55d27c4b9dd7d7)]:
  - @routedock/nulth-sdk@0.2.0
