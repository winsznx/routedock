---
"@routedock/routedock": minor
---

mpp-session providers now turn on `@stellar/mpp`'s on-chain channel check through a new `channelStateCheck` option (enabled by default on mainnet), so vouchers above the channel balance or past the close-effective ledger get 402. A detected refund dispute fires `onDisputeDetected` and closes the channel with the highest verified voucher, falling back to an `onOrphaned` flag with the new `'dispute'` reason. Every RouteDock close (DELETE, dispute, and the reconciler when given `store`) now writes `stellar:channel:closed:<channel>` so later vouchers are rejected.
