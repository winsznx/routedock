---
"@routedock/routedock": patch
"@routedock/mcp-server": patch
---

Preserve settled payments when provider responses are not JSON. Return raw text and content type, retain spend reservations on unreadable paid bodies, and expose paid settlement metadata to MCP callers so agents do not retry a completed payment.
