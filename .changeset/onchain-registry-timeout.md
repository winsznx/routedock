---
"@routedock/routedock": patch
---

Honor `OnChainRegistry`'s `timeoutMs` so a stalled Horizon no longer hangs `listProviders()` indefinitely: account loads now time out, run concurrently, and clear their timers on every path. `ProviderRegistryConfig.onChain` gains an optional `timeoutMs` (default 10000 ms per account) that is forwarded to the registry.
