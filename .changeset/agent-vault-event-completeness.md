---
"@routedock/routedock": minor
---

Agent vault contract events are now complete and carry previous values. **Breaking for anyone indexing vault events:** `expiry_updated` data is now `(old_expiry, new_expiry)` (was the new expiry), `agent_key_rotated` data is now `(old_pk, new_pk)` (was the new key), `allowlist_updated` data is now `(previous_sub_cap, new_sub_cap)` (was the new sub-cap or `None`), and `vault_frozen` / `vault_unfrozen` gain an `admin` topic. The constructor now emits `vault_initialized` with the deploy-time policy, `remove_from_allowlist` on an unlisted payee and redundant `freeze` / `unfreeze` calls no longer emit events, and the README documents every event layout.
