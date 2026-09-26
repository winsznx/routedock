---
"@routedock/routedock": patch
---

`mpp-session-ws` streams now call the local spend-cap hook before each signed voucher, and `vouchersIssued` counts one voucher per signed connection instead of one per frame.