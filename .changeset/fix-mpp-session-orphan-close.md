---
"@routedock/routedock": patch
---

Fix Express and Fastify `mpp-session` calling `onOrphaned` after every voucher. The disconnect detector now listens on the response `close` event and only flags a response that did not finish, instead of the request `close` event, which Node fires on normal completion.
