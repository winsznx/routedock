---
'@routedock/routedock': minor
---

Add `client.preflight(url)`: fetches and validates a provider's manifest and returns the supported modes, an estimated cost per mode, and deprecation/sunset compliance flags, with no money movement and no trustline check. The existing `preflight(manifest, mode?, endpoint?)` form is unchanged.
