# Changelog

## Unreleased

- Replace the agent vault's immediate Wasm upgrade entry point with an admin-announced 17,280-ledger proposal delay, explicit execution, cancellation, and pending-upgrade views.
- Scope abandoned MPP session recovery to the configured network and payee, process the oldest recoverable rows first, and correct testnet USDC trustline remediation.

## 0.1.0
- Initial release of RouteDock.
- Unified payment execution layer for autonomous agents on Stellar.
- Support for x402, MPP charge, and MPP session modes.
- Soroban agent-vault contract for session management.
- SDK for easy integration.
- Dashboard for tracking payments and sessions.
