---
"@routedock/routedock": minor
---

`X402Client` now selects the payment scheme from the signer it is given: a Nulth
signer (carrying `NULTH_SIGNER_MARKER`) goes through the new `NulthStellarScheme`,
which assembles the USDC transfer, binds the `zk-v1` proof into the authorization
entry with `nulthAuthorizeEntry` and re-simulates before returning the transaction,
while a keypair signer keeps using `ExactStellarScheme`. Previously a Nulth vault
swap reached a scheme that signs with an ed25519 key, so `client.pay()` with
`vault: 'nulth'` failed before the proof was ever built. `selectStellarScheme` is
exported for callers that build an x402 client by hand.
