---
'@routedock/routedock': patch
---

Make `SessionHandle.close()` idempotent across duplicate, concurrent, and post-auto-close calls (while allowing retries after failure), reject `mpp-session-ws` `stream()` calls after `close()` before spending or probing, and close active WebSockets with code `1000` on `close()` (#726).
