---
'@routedock/routedock': minor
---

SupabaseSessionStore now writes channel_contract and network, which fixes the NOT NULL failure on every upsert. SessionState gains two required fields, channel_contract and network. SessionStore gains setStatus(channelId, status, settlementTxHash?) for status changes that must not touch cumulative_amount, and close() now delegates to it.
