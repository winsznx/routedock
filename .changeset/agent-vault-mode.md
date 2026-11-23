---
'@routedock/routedock': minor
---

Add `agent-vault` custody mode (#721). `RouteDockClient` accepts `vault: { mode: 'agent-vault', vaultContract, agentSecret }` and pays x402 endpoints from the AgentVault contract account, signing the auth entry with the agent key as the raw 64-byte signature the vault's `__check_auth` expects (`agentVaultAuthorizeEntry`, `AgentVaultStellarScheme`). Vault policy refusals found while simulating (`#3` expired, `#4` daily cap, `#5` payee not allowed, `#9` frozen) surface as `RouteDockPolicyRejectError`. `mpp-charge` and sessions are rejected with a clear error in this mode.
