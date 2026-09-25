---
"@routedock/routedock": minor
---

Validate every `mpp-session` / `mpp-session-ws` 402 challenge against the signed manifest before anything is signed. The provider authors the challenge and the channel client signed its `cumulativeAmount` verbatim, so one voucher could commit the whole channel deposit (and the daily cap, which reserves `pricing.rate`, never saw it). Challenges are now rejected with `RouteDockChannelStateError` when they name a different channel than `channel_factory`, when `request.amount` differs from `pricing.rate`, or when `methodDetails.cumulativeAmount` is malformed or above the locally reserved baseline; the signed value is always the client's own arithmetic. New `SessionOptions.store` (an mppx `Store`) seeds that baseline across sessions — without one, a session fails closed on a challenge reporting a non-zero cumulative instead of trusting it.
