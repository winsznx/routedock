---
'@routedock/routedock': patch
---

The package root now exports `MppSessionClient` (and its `WebSocketFactory` / `WebSocketLike` types), so `import { MppSessionClient } from '@routedock/routedock'` works instead of only `@routedock/routedock/client`. A new entry-export parity test fails if the two entries' runtime exports drift apart again, and `RouteDockClient` stores its commitment secret once instead of twice.
