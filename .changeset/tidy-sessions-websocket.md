---
"@routedock/routedock": minor
---

Add `mpp-session-ws`: a WebSocket transport variant of `mpp-session` that opens the channel, negotiates the voucher over HTTP, then upgrades the connection to WebSocket for push-based streaming from inference providers. Includes Hono provider support (shared channel store across both session transports), manifest schema, and mode selection via a `transport: 'websocket'` option.
