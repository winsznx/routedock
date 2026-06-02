# Streaming Orderbook Agent

This cookbook opens an MPP session against Provider B's `GET /stream/orderbook` endpoint, consumes 100 voucher-backed orderbook updates, prints spread and mid-price stats, then closes the session so the provider can settle the highest cumulative voucher on-chain.

## Setup

1. Install dependencies from this folder:

   ```bash
   pnpm install
   ```

2. Create and fund a Stellar testnet agent keypair.

   You can generate a keypair with any Stellar SDK or wallet, then fund its public key through Friendbot:

   ```bash
   curl "https://friendbot.stellar.org?addr=G..."
   ```

3. Create the example environment file:

   ```bash
   cp .env.example .env
   ```

4. Fill in `.env`:

   ```bash
   AGENT_SECRET=S...
   COMMITMENT_SECRET=S...
   PROVIDER_B_URL=https://api-b.routedock.xyz
   STELLAR_NETWORK=testnet
   ```

   `AGENT_SECRET` identifies the session payer. `COMMITMENT_SECRET` signs the monotonic MPP vouchers. The provider must be configured with the matching `COMMITMENT_PUBLIC_KEY`; when running your own Provider B, set that env var to the public key derived from `COMMITMENT_SECRET`. For a quick local testnet cookbook run, `AGENT_SECRET` and `COMMITMENT_SECRET` can be the same funded keypair; production agents should use a separate commitment key.

## Run

```bash
pnpm start
```

The script demonstrates the full client lifecycle:

- `new RouteDockClient(...)`
- `client.openSession(...)`
- `for await (const update of session.stream())`
- `session.close()` on completion or Ctrl+C
- settled close transaction hash logged to stdout

## Successful Run

An asciinema-format transcript of a successful run is included at [`success.cast`](success.cast). The final lines should look like:

```text
[session] closing (received 100 updates)...
[session] settled tx hash: <settled-testnet-tx-hash>
[session] vouchers issued: 100
[session] total paid: 0.0100000 USDC
```

The close hash can be checked on Stellar Expert testnet:

```text
https://stellar.expert/explorer/testnet/tx/<settled-tx-hash>
```
