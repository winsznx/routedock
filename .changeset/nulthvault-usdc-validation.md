---
"@routedock/routedock": patch
---

The Nulth vault path now parses the daily cap and manifest prices with the validated `usdcToStroops`, so negative, empty and over-precise amounts throw `RangeError` instead of being accepted or truncated.
