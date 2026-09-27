---
"@routedock/routedock": patch
"@routedock/nulth-sdk": patch
---

Point the `require` condition in both SDKs' `exports` maps at the emitted `.d.cts` declarations, so CommonJS TypeScript consumers on `node16` or `nodenext` resolution no longer read ESM types for a CJS runtime.
