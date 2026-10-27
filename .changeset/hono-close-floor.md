---
"@routedock/routedock": patch
---

Floor the Hono mpp-session DELETE close at the highest voucher mppx verified.

A rebuilt `routedockHono` (a Durable Object that was evicted or redeployed) can reach the close path with no routedock voucher record: the session opened before the record was persisted, or the record write failed. The close then had nothing to compare the client's amount against. It now reads mppx's stored cumulative entry for the channel and answers `409` instead of broadcasting a close below it; the entry is mppx's own and is left untouched, so a later session on the same channel still sees it.
