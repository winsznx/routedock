# @routedock/sdk

Unified payment execution layer for autonomous agents on Stellar. One SDK for x402, MPP charge, and MPP session — mode selected automatically from the provider's `routedock.json` manifest.

## Install

```bash
npm install @routedock/sdk
# or
pnpm add @routedock/sdk
```

## Agent Usage

```ts
import { RouteDockClient } from '@routedock/sdk/client'
import { Keypair } from '@stellar/stellar-sdk'

const client = new RouteDockClient({
  wallet: Keypair.fromSecret(process.env.AGENT_SECRET),
  network: 'testnet',
  spendCap: { daily: '1.00', asset: 'USDC' }, // optional local guard
})

// Single call — SDK reads manifest, picks mode automatically
const result = await client.pay('https://provider.railway.app/price')
// result.data   — response body
// result.txHash — settlement hash (or null for session vouchers)
// result.mode   — 'x402' | 'mpp-charge' | 'mpp-session'

// Sustained streaming access
const session = await client.openSession('https://provider.railway.app/stream/orderbook')
for await (const update of session.stream()) {
  console.log(update)
  if (done) break
}
await session.close() // triggers on-chain settlement
```

## Provider Usage

```ts
import express from 'express'
import { routedock, SupabaseSessionStore } from '@routedock/sdk/provider'
import { createClient } from '@supabase/supabase-js'

const app = express()

// Price endpoint — x402 + MPP charge
app.use('/price', routedock({
  modes: ['x402', 'mpp-charge'],
  pricing: { x402: '0.001', 'mpp-charge': '0.0008' },
  asset: 'USDC',
  payee: process.env.STELLAR_PAYEE_ADDRESS,
  network: process.env.STELLAR_NETWORK as 'testnet' | 'mainnet',
  facilitatorApiKey: process.env.OPENZEPPELIN_API_KEY,
}))

// Stream endpoint — MPP session only
const store = new SupabaseSessionStore(createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY))
app.use('/stream/orderbook', routedock({
  modes: ['mpp-session'],
  pricing: { 'mpp-session': { rate: '0.0001', channelContract: process.env.CHANNEL_CONTRACT_ID } },
  asset: 'USDC',
  payee: process.env.STELLAR_PAYEE_ADDRESS,
  network: process.env.STELLAR_NETWORK as 'testnet' | 'mainnet',
  store,
}))
```

## Mode Selection Logic

The `ModeRouter` uses this decision tree (deterministic, no randomness):

1. If `{ sustained: true }` passed AND manifest supports `mpp-session` → session
2. Else if manifest supports `mpp-charge` AND network is Stellar → MPP charge (lower fees)
3. Else if manifest supports `x402` → x402 with OZ facilitator
4. Else throw `RouteDockNoSupportedModeError`

Override with `{ forceMode: 'x402' }` to bypass auto-selection.

## Security

The `one-way-channel` Soroban contract wrapped by `MppSessionClient` is **unaudited** (`stellar-experimental/one-way-channel`). Safe defaults are enforced: 17280 ledger refund window, durable `SupabaseSessionStore` with monotonic invariant. Production use should await a formal audit.

## License

MIT
