---
"@routedock/routedock": minor
---

Emit `session:close-failed` when the `maxDurationMs` auto-close rejects, carrying the rejection and the elapsed budget, and report it through `console.warn`. Previously the failure was swallowed with no event and no log, so a caller could not tell that the channel collateral was still locked. `SessionHandle.on()` now narrows listener payloads per event through `SessionEventPayloadMap`.
