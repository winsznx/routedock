# @routedock/routedock

## 0.2.0

### Minor Changes

- [#180](https://github.com/winsznx/routedock/pull/180) [`4da4b78`](https://github.com/winsznx/routedock/commit/4da4b78729b0a31866cef1c99539f54152734293) Thanks [@Jaydearcadian](https://github.com/Jaydearcadian)! - Restore the public npm release pipeline, build every publishable package before publication, and prepare the RouteDock packages for their 0.2.0 releases.

- [#181](https://github.com/winsznx/routedock/pull/181) [`e0eea65`](https://github.com/winsznx/routedock/commit/e0eea652e4893373e147f785344987e19f66cac6) Thanks [@Jaydearcadian](https://github.com/Jaydearcadian)! - Enforce manifest and payment-mode deprecation, reject sunset manifests including cached entries, and expose per-endpoint deprecation metadata.

- [#240](https://github.com/winsznx/routedock/pull/240) [`5c6b01f`](https://github.com/winsznx/routedock/commit/5c6b01ff33117688f65ef3bcc1d6e40e20a4e7d8) Thanks [@chiomailekuba](https://github.com/chiomailekuba)! - Secure manifest signatures with versioned recursive canonicalization so nested pricing, endpoint, channel, SLA, and capability fields cannot be modified without invalidating the signature.

- [#231](https://github.com/winsznx/routedock/pull/231) [`291afa5`](https://github.com/winsznx/routedock/commit/291afa5a1f443136a62f59eea360ac35f6191d4b) Thanks [@melanindebbie](https://github.com/melanindebbie)! - Respect `Cache-Control: max-age` / `Expires` response headers for per-entry manifest cache TTL, and expose `RouteDockClient.invalidateManifest(url)` for explicit eviction so provider manifest updates take effect before the default TTL expires.

- [#227](https://github.com/winsznx/routedock/pull/227) [`d291a14`](https://github.com/winsznx/routedock/commit/d291a14ef40faa9daca60d514569a4abc4d26a64) Thanks [@melanindebbie](https://github.com/melanindebbie)! - Add `mpp-session-ws`: a WebSocket transport variant of `mpp-session` that opens the channel, negotiates the voucher over HTTP, then upgrades the connection to WebSocket for push-based streaming from inference providers. Includes Hono provider support (shared channel store across both session transports), manifest schema, and mode selection via a `transport: 'websocket'` option.

### Patch Changes

- [#241](https://github.com/winsznx/routedock/pull/241) [`d9ac7f4`](https://github.com/winsznx/routedock/commit/d9ac7f4fbf095f47acb2b9d9fc305f4157b12ee3) Thanks [@chiomailekuba](https://github.com/chiomailekuba)! - Preserve typed Stellar MPP channel verification failures and make provider-side channel envelope authorization explicit during close and recovery operations.

- [#260](https://github.com/winsznx/routedock/pull/260) [`e571dd4`](https://github.com/winsznx/routedock/commit/e571dd4f0b6b4f9058235eca0bb0d5ecf262e047) Thanks [@Olalolo22](https://github.com/Olalolo22)! - Add registerProvider helper to verify manifest signature and upsert into Supabase provider registry on startup.

- [#237](https://github.com/winsznx/routedock/pull/237) [`2eac983`](https://github.com/winsznx/routedock/commit/2eac983f738b83fecbc259b94e55d27c4b9dd7d7) Thanks [@TS-mfon](https://github.com/TS-mfon)! - Block the insecure Nulth mock prover on mainnet and stop advertising an unimplemented WASM backend.

- Updated dependencies [[`4da4b78`](https://github.com/winsznx/routedock/commit/4da4b78729b0a31866cef1c99539f54152734293), [`2eac983`](https://github.com/winsznx/routedock/commit/2eac983f738b83fecbc259b94e55d27c4b9dd7d7)]:
  - @routedock/nulth-sdk@0.2.0
