# @routedock/routedock

## 0.2.0

### Minor Changes

- [#180](https://github.com/winsznx/routedock/pull/180) [`4da4b78`](https://github.com/winsznx/routedock/commit/4da4b78729b0a31866cef1c99539f54152734293) Thanks [@Jaydearcadian](https://github.com/Jaydearcadian)! - Restore the public npm release pipeline, build every publishable package before publication, and prepare the RouteDock packages for their 0.2.0 releases.

- [#181](https://github.com/winsznx/routedock/pull/181) [`e0eea65`](https://github.com/winsznx/routedock/commit/e0eea652e4893373e147f785344987e19f66cac6) Thanks [@Jaydearcadian](https://github.com/Jaydearcadian)! - Enforce manifest and payment-mode deprecation, reject sunset manifests including cached entries, and expose per-endpoint deprecation metadata.

- [#477](https://github.com/winsznx/routedock/pull/477) [`772106d`](https://github.com/winsznx/routedock/commit/772106de701d782447df93a0c017699b41f1bf15) Thanks [@Mayor-Isaac](https://github.com/Mayor-Isaac)! - Enforce the per-endpoint `deprecated` and `sunset_at` metadata. `pay()`, `estimateCost()` and `openSession()` now refuse a URL whose matching endpoint descriptor has passed its `sunset_at` with a `RouteDockManifestSunsetError`, and log a `[RouteDock] WARNING:` line before paying a deprecated endpoint.

- [#240](https://github.com/winsznx/routedock/pull/240) [`5c6b01f`](https://github.com/winsznx/routedock/commit/5c6b01ff33117688f65ef3bcc1d6e40e20a4e7d8) Thanks [@chiomailekuba](https://github.com/chiomailekuba)! - Secure manifest signatures with versioned recursive canonicalization so nested pricing, endpoint, channel, SLA, and capability fields cannot be modified without invalidating the signature.

- [#439](https://github.com/winsznx/routedock/pull/439) [`28716eb`](https://github.com/winsznx/routedock/commit/28716eb373d9a575b7e8b1f650b532373cfccd20) Thanks [@Cerome360](https://github.com/Cerome360)! - Validate every `mpp-session` / `mpp-session-ws` 402 challenge against the signed manifest before anything is signed. The provider authors the challenge and the channel client signed its `cumulativeAmount` verbatim, so one voucher could commit the whole channel deposit (and the daily cap, which reserves `pricing.rate`, never saw it). Challenges are now rejected with `RouteDockChannelStateError` when they name a different channel than `channel_factory`, when `request.amount` differs from `pricing.rate`, or when `methodDetails.cumulativeAmount` is malformed or above the locally reserved baseline; the signed value is always the client's own arithmetic. New `SessionOptions.store` (an mppx `Store`) seeds that baseline across sessions — without one, a session fails closed on a challenge reporting a non-zero cumulative instead of trusting it.

- [#506](https://github.com/winsznx/routedock/pull/506) [`59b0fc9`](https://github.com/winsznx/routedock/commit/59b0fc9fb3b95c9a22f8aeb1c73d332c9398412a) Thanks [@Cerome360](https://github.com/Cerome360)! - Stop `MppSessionClient.stream()` from issuing vouchers after the session closes. `close()` set an internal `closed` flag that only the `maxDurationMs` timer read, so a consumer that kept pulling the iterator ran `checkSpend()` and `mppx.fetch()` again — signing cumulative amounts above the one `close()` settles on-chain. The sequential loop and the pipelined window refill now check the flag first and end the stream with `RouteDockChannelStateError: session closed`, so a manual `close()` and the lifetime guard both halt voucher issuance immediately.

- [#449](https://github.com/winsznx/routedock/pull/449) [`f36fd32`](https://github.com/winsznx/routedock/commit/f36fd329e4cfaaf73466b5e501f2c2e8325c253c) Thanks [@TS-mfon](https://github.com/TS-mfon)! - SupabaseSessionStore now writes channel_contract and network, which fixes the NOT NULL failure on every upsert. SessionState gains two required fields, channel_contract and network. SessionStore gains setStatus(channelId, status, settlementTxHash?) for status changes that must not touch cumulative_amount, and close() now delegates to it.

- [#231](https://github.com/winsznx/routedock/pull/231) [`291afa5`](https://github.com/winsznx/routedock/commit/291afa5a1f443136a62f59eea360ac35f6191d4b) Thanks [@melanindebbie](https://github.com/melanindebbie)! - Respect `Cache-Control: max-age` / `Expires` response headers for per-entry manifest cache TTL, and expose `RouteDockClient.invalidateManifest(url)` for explicit eviction so provider manifest updates take effect before the default TTL expires.

- [#227](https://github.com/winsznx/routedock/pull/227) [`d291a14`](https://github.com/winsznx/routedock/commit/d291a14ef40faa9daca60d514569a4abc4d26a64) Thanks [@melanindebbie](https://github.com/melanindebbie)! - Add `mpp-session-ws`: a WebSocket transport variant of `mpp-session` that opens the channel, negotiates the voucher over HTTP, then upgrades the connection to WebSocket for push-based streaming from inference providers. Includes Hono provider support (shared channel store across both session transports), manifest schema, and mode selection via a `transport: 'websocket'` option.

- [#437](https://github.com/winsznx/routedock/pull/437) [`527ab9a`](https://github.com/winsznx/routedock/commit/527ab9a55cbc48671b8f71fe0e3a69f90a0adcbd) Thanks [@Cerome360](https://github.com/Cerome360)! - Emit `session:close-failed` when the `maxDurationMs` auto-close rejects, carrying the rejection and the elapsed budget, and report it through `console.warn`. Previously the failure was swallowed with no event and no log, so a caller could not tell that the channel collateral was still locked. `SessionHandle.on()` now narrows listener payloads per event through `SessionEventPayloadMap`.

### Patch Changes

- [#469](https://github.com/winsznx/routedock/pull/469) [`34a1a79`](https://github.com/winsznx/routedock/commit/34a1a7961b9aa61a006a654ea8c1835b0529002e) Thanks [@joydeelish](https://github.com/joydeelish)! - Point the require condition in exports at the emitted .d.cts declarations so CJS consumers on node16/nodenext get CJS types.

- [#241](https://github.com/winsznx/routedock/pull/241) [`d9ac7f4`](https://github.com/winsznx/routedock/commit/d9ac7f4fbf095f47acb2b9d9fc305f4157b12ee3) Thanks [@chiomailekuba](https://github.com/chiomailekuba)! - Preserve typed Stellar MPP channel verification failures and make provider-side channel envelope authorization explicit during close and recovery operations.

- [#496](https://github.com/winsznx/routedock/pull/496) [`b9f4fd6`](https://github.com/winsznx/routedock/commit/b9f4fd615019fe2b85903478eca9b6b4e195de6c) Thanks [@Olalolo22](https://github.com/Olalolo22)! - Fix Fastify provider adapter reply hijacking before payment handler execution so paid requests do not hang after settlement.

- [#452](https://github.com/winsznx/routedock/pull/452) [`8a69faf`](https://github.com/winsznx/routedock/commit/8a69faf805c9638fba44350913d43d85940f500f) Thanks [@Times-stack](https://github.com/Times-stack)! - Normalize `spendCap.endpointCaps` keys to their URL origin in `RouteDockClient`, so a trailing slash, uppercase host, or explicit default port no longer silently disables that endpoint's cap. A key that isn't a valid URL, includes a path/query/hash, or normalizes to the same origin as another key now throws a `RouteDockManifestError` at construction instead of the cap being dropped without warning.

- [#495](https://github.com/winsznx/routedock/pull/495) [`11b531f`](https://github.com/winsznx/routedock/commit/11b531fa799082d70645a3d07f7e29a2ff16553c) Thanks [@oscarj007](https://github.com/oscarj007)! - Fix the React docs to warn that browser-side RouteDockClient usage exposes any wallet secret, and replace the public-secret example with a throwaway testnet key plus a server-side example using AGENT_SECRET.

- [#441](https://github.com/winsznx/routedock/pull/441) [`98fc671`](https://github.com/winsznx/routedock/commit/98fc671b25d858010a5bc52c451b936852028be7) Thanks [@Yerimahjr](https://github.com/Yerimahjr)! - Nulth signers now decode the Soroban auth entry before signing and reject it with `NulthPolicyError` code `auth_entry_mismatch` unless it is a single `transfer` on `assetContract` from the Nulth account to `paymentContext.payee` for exactly `paymentContext.amountStroops`, with no sub-invocations. `assertAuthEntryMatchesContext` is exported from `@routedock/nulth-sdk`.

- [#518](https://github.com/winsznx/routedock/pull/518) [`a9872e0`](https://github.com/winsznx/routedock/commit/a9872e0a59b0b2055cf5cb6e20be60a6445e23b6) Thanks [@chykason77-blip](https://github.com/chykason77-blip)! - Reject a malformed `budget_per_request` with `RouteDockPolicyRejectError('invalid_budget_per_request')` instead of treating it as no ceiling, and compare the ceiling against mode prices as integer stroops rather than floats. A value like `'abc'` previously parsed to `NaN`, which read as an unlimited budget, so `optimize: 'cost'` ignored the caller's cap and could select the cheapest mode at any price.

- [#470](https://github.com/winsznx/routedock/pull/470) [`665ace7`](https://github.com/winsznx/routedock/commit/665ace7d45422c7190b3331196316ba63b181243) Thanks [@joydeelish](https://github.com/joydeelish)! - A 200 response with a non-JSON body now rejects with `RouteDockManifestError` on mpp-charge and `RouteDockChannelStateError` on session voucher and close, instead of a raw `SyntaxError`.

- [#480](https://github.com/winsznx/routedock/pull/480) [`b9d8b7e`](https://github.com/winsznx/routedock/commit/b9d8b7ef84f9cf3b484efc4b56d06de93dd193be) Thanks [@Mayor-Isaac](https://github.com/Mayor-Isaac)! - Make the Nulth mainnet guard fail closed. `NulthClient` construction now throws unless `network` is `'testnet'`, and throws on any prover other than `'mock'`, so a missing or misspelled network (for example `'pubnet'`), a network read from env or JSON, or a legacy `prover: 'wasm'` setting can no longer produce a mock-proof client on a non-testnet network.

- [#447](https://github.com/winsznx/routedock/pull/447) [`e22f931`](https://github.com/winsznx/routedock/commit/e22f9314e9176eee5452cf7eb6ae2fafbba00760) Thanks [@simonpeters298](https://github.com/simonpeters298)! - Honor `OnChainRegistry`'s `timeoutMs` so a stalled Horizon no longer hangs `listProviders()` indefinitely: account loads now time out, run concurrently, and clear their timers on every path. `ProviderRegistryConfig.onChain` gains an optional `timeoutMs` (default 10000 ms per account) that is forwarded to the registry.

- [#530](https://github.com/winsznx/routedock/pull/530) [`2f44845`](https://github.com/winsznx/routedock/commit/2f448451c6e419ff75b45280ceb4d3b4518d52c0) Thanks [@DanbabaJr](https://github.com/DanbabaJr)! - Stop reading the vault admin secret env var. The `record_session_settlement` call on the
  agent vault is now authorized by the allowlisted payee's own key, which is also the
  transaction source, so providers no longer need — and must no longer be given — the
  vault admin secret. `payee.require_auth()` on the contract enforces this; the admin
  key keeps guarding `upgrade`, `set_agent_pubkey` and the cap/allowlist setters.

  The `AGENT_VAULT_CONTRACT` env var is still the only variable that enables the vault
  record. Transaction construction moved into a testable
  `buildSessionSettlementTransaction` helper in `provider/internal/vaultSettlement.ts`.

  Already-deployed vaults keep the admin-gated function until their admin uploads the
  new wasm and calls `upgrade`; against those vaults this call fails and is logged,
  leaving the channel close response unaffected.

- [#260](https://github.com/winsznx/routedock/pull/260) [`e571dd4`](https://github.com/winsznx/routedock/commit/e571dd4f0b6b4f9058235eca0bb0d5ecf262e047) Thanks [@Olalolo22](https://github.com/Olalolo22)! - Add registerProvider helper to verify manifest signature and upsert into Supabase provider registry on startup.

- [#467](https://github.com/winsznx/routedock/pull/467) [`155e610`](https://github.com/winsznx/routedock/commit/155e610d1a2cd0a8419b3169e484183a342dd666) Thanks [@joydeelish](https://github.com/joydeelish)! - Publish only dist/ and README.md from each package.

- [#508](https://github.com/winsznx/routedock/pull/508) [`20d6e82`](https://github.com/winsznx/routedock/commit/20d6e829be31d84860e9e706c1d19afb76cdd640) Thanks [@odarome132](https://github.com/odarome132)! - Abandoned MPP session recovery now selects only the rows it can actually settle. The reconciler filters on the configured `network` and on the payee public key, requires a non-null `last_signature` (an unsigned row cannot be closed and no longer consumes a slot in the batch), and orders by `updated_at` ascending before `limit(100)`. Previously a mixed-network or mixed-payee backlog could fill the whole batch with rows this provider would skip, so older recoverable sessions were starved and never settled.

- [#237](https://github.com/winsznx/routedock/pull/237) [`2eac983`](https://github.com/winsznx/routedock/commit/2eac983f738b83fecbc259b94e55d27c4b9dd7d7) Thanks [@TS-mfon](https://github.com/TS-mfon)! - Block the insecure Nulth mock prover on mainnet and stop advertising an unimplemented WASM backend.

- [#450](https://github.com/winsznx/routedock/pull/450) [`4d89d36`](https://github.com/winsznx/routedock/commit/4d89d36099a71d652b4b15f515af398d502eccd7) Thanks [@TS-mfon](https://github.com/TS-mfon)! - Handle queued in-flight voucher fetch rejections in MppSessionClient.stream() pipelined mode

- [#451](https://github.com/winsznx/routedock/pull/451) [`6ae3ff5`](https://github.com/winsznx/routedock/commit/6ae3ff506bcf7c969d928821dd0aa1d89240b17c) Thanks [@Times-stack](https://github.com/Times-stack)! - Fix mpp-session provider adapters (Hono and Express) committing an unverified Payment header's signature and payer to session state before mppx verified the credential. Voucher state is now written only from a credential onVerifiedCredential has confirmed mppx actually verified, so a crafted, unverified header can no longer poison the signature or payer a later close or orphan-recovery uses.

  Also: in the Hono adapter, the verified voucher record now survives handler-instance eviction (e.g. a Cloudflare Durable Object recycling) by reloading it from the session store before it's needed.

- [#261](https://github.com/winsznx/routedock/pull/261) [`890c491`](https://github.com/winsznx/routedock/commit/890c4918567a1124569fd99246d4983142f440fd) Thanks [@Olalolo22](https://github.com/Olalolo22)! - Export SessionReconciler helpers and types from the SDK and provider hono entrypoints for automated session reconciliation.

- [#443](https://github.com/winsznx/routedock/pull/443) [`8b9b431`](https://github.com/winsznx/routedock/commit/8b9b431edd705c3ecc704f701fd11b109e8a18cb) Thanks [@Yerimahjr](https://github.com/Yerimahjr)! - Honor `Cache-Control: no-store` and `no-cache` in the manifest cache so those responses are never reused.

- [#440](https://github.com/winsznx/routedock/pull/440) [`69bd6bf`](https://github.com/winsznx/routedock/commit/69bd6bfb920e6e9aaea23259fb1d9e3c07e3b4d1) Thanks [@TS-mfon](https://github.com/TS-mfon)! - Trustline preflight now requires the expected USDC issuer, and the testnet USDC issuer is corrected to GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5.

- [#509](https://github.com/winsznx/routedock/pull/509) [`5df718e`](https://github.com/winsznx/routedock/commit/5df718ef257a33587a0e9319fc87ca7d009a1339) Thanks [@odarome132](https://github.com/odarome132)! - Trustline onboarding and trustline remediation now share one source of truth for USDC issuers. `USDC_ISSUERS` is exported from `internal/usdc.ts` and the client's preflight reads it instead of keeping a second copy, so the `change-trust` command inside a `RouteDockTrustlineError` can no longer drift from the issuer the client actually accepts. The `agent-to-agent`, `inference-agent` and `price-oracle-agent` READMEs now include the missing trustline step (and Circle's testnet faucet) that the payment paths require before the first run.

- [#445](https://github.com/winsznx/routedock/pull/445) [`457f462`](https://github.com/winsznx/routedock/commit/457f46258f29d53fe4188583abf47677594dc80a) Thanks [@melanindebbie](https://github.com/melanindebbie)! - A 200 manifest response with a non-JSON body now rejects with a non-retryable `RouteDockManifestError`. A malformed 402 `X-Payment-Requirements` header now rejects with `RouteDockManifestError` carrying the decode error as `cause`. `ProviderRegistry` filters Supabase providers by its configured network.

- [#482](https://github.com/winsznx/routedock/pull/482) [`5d6f6b1`](https://github.com/winsznx/routedock/commit/5d6f6b1f412b24d5eaf3112c8d1936f97bad7b42) Thanks [@oscarj007](https://github.com/oscarj007)! - `mpp-session-ws` streams now call the local spend-cap hook before each signed voucher, and `vouchersIssued` counts one voucher per signed connection instead of one per frame.

- Updated dependencies [[`34a1a79`](https://github.com/winsznx/routedock/commit/34a1a7961b9aa61a006a654ea8c1835b0529002e), [`4da4b78`](https://github.com/winsznx/routedock/commit/4da4b78729b0a31866cef1c99539f54152734293), [`98fc671`](https://github.com/winsznx/routedock/commit/98fc671b25d858010a5bc52c451b936852028be7), [`b9d8b7e`](https://github.com/winsznx/routedock/commit/b9d8b7ef84f9cf3b484efc4b56d06de93dd193be), [`155e610`](https://github.com/winsznx/routedock/commit/155e610d1a2cd0a8419b3169e484183a342dd666), [`2eac983`](https://github.com/winsznx/routedock/commit/2eac983f738b83fecbc259b94e55d27c4b9dd7d7)]:
  - @routedock/nulth-sdk@0.2.0
