---
"@routedock/routedock": minor
---

Align `@routedock/routedock/testing` with the real provider callbacks. `MockRoutedockCallbacks` is now derived from `RouteDockMiddlewareOptions`, so it cannot drift again: `onSettled` receives `payer` as its 4th argument and `onSessionOpen` as its 2nd. `SyntheticPayment.payer` defaults to a valid Stellar account and preserves an explicit `null` for the address-unavailable path, and `mpp-session-ws` now runs the full session sequence (open, vouchers, close) with `onSettled` reporting its transport as `mode`.
