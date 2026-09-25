---
"@routedock/routedock": patch
"@routedock/nulth-sdk": patch
"@routedock/mcp-server": patch
---

Declare a `files` field in every publishable package so npm tarballs ship only `dist/` and the README instead of test sources, release notes and local config templates. `scripts/check-pack.sh` now runs inside `pnpm verify` and fails if any packed path falls outside `dist/` or if a declared entry point is missing from the tarball.
