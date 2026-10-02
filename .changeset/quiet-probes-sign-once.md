---
"@routedock/routedock": patch
---

Sign at most one payment per `pay()` call. `X402Client.pay` and `MppChargeClient.pay` used to wrap their whole payment flow in `withRetry`, so every retry sent a fresh unpaid probe, received a fresh 402 and signed a fresh payment — one `client.pay()` against a flaky route could settle up to `maxAttempts` on-chain payments while the spend cap recorded one. The unpaid probe is now retried on its own, the payment (x402 payload, mpp-charge credential) is created exactly once, and only the paid request is retried, resending the byte-identical headers so the provider's idempotency store can replay the cached settlement instead of charging again.
