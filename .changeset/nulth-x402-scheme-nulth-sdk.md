---
"@routedock/nulth-sdk": minor
---

Adds the Nulth x402 signing pieces: `NULTH_SIGNER_MARKER` marks a signer built by
`createNulthSigner()` so a client can tell a ZK account payer from an ed25519 key,
`nulthProofScVal`/`decodeNulthProofScVal` encode and read the `zk-v1` proof
envelope that goes into `SorobanAddressCredentials.signature`, and
`nulthAuthorizeEntry` replaces stellar-sdk's default authorization writer — which
throws `invalid version byte. expected 48, got 16` for a `C...` contract account
(#356) — with one that stores the proof instead of an ed25519 signature.
