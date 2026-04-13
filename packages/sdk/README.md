# @routedock/routedock

Unified payment execution layer for autonomous agents on Stellar. One SDK for x402, MPP charge, and MPP session — mode selected automatically from the provider's `routedock.json` manifest.

## Install

```bash
npm install @routedock/routedock
```

## Agent Usage

```ts
import { RouteDockClient } from '@routedock/routedock/client'
import { Keypair } from '@stellar/stellar-sdk'

const client = new RouteDockClient({
  wallet: Keypair.fromSecret(process.env.AGENT_SECRET),
  network: 'testnet',
  spendCap: { daily: '1.00', asset: 'USDC' },
})

// Single call — SDK reads manifest, picks mode automatically
const result = await client.pay('https://provider.example.com/price')
// result.data   — response body
// result.txHash — settlement hash (or null for session vouchers)
// result.mode   — 'x402' | 'mpp-charge' | 'mpp-session'

// Sustained streaming access
const session = await client.openSession('https://provider.example.com/stream/orderbook')
for await (const update of session.stream()) {
  console.log(update)
  if (done) break
}
await session.close() // triggers on-chain settlement
```

## Provider Usage

```ts
import express from 'express'
import { routedock } from '@routedock/routedock/provider'

const app = express()

app.use('/price', routedock({
  modes: ['x402', 'mpp-charge'],
  pricing: { x402: '0.001', 'mpp-charge': '0.0008' },
  asset: 'USDC',
  assetContract: process.env.USDC_ASSET_CONTRACT,
  payee: process.env.STELLAR_PAYEE_ADDRESS,
  network: 'testnet',
  payeeSecretKey: process.env.STELLAR_PAYEE_SECRET,
  manifest,
  onSettled: async (txHash, amount, mode) => {
    console.log(`settled: ${mode} ${amount} USDC — ${txHash}`)
  },
}))
```

## Session Lifecycle Hooks

For `mpp-session` mode, the middleware exposes three hooks that fire at each stage of the payment channel lifecycle:

```ts
app.use('/stream', routedock({
  modes: ['mpp-session'],
  pricing: { 'mpp-session': { rate: '0.0001', channelContract: CHANNEL_CONTRACT } },
  asset: 'USDC',
  assetContract: USDC_ASSET_CONTRACT,
  payee: PAYEE_ADDRESS,
  network: 'testnet',
  payeeSecretKey: PAYEE_SECRET,
  manifest,
  commitmentPublicKey: COMMITMENT_PUBLIC_KEY,

  // Fires once when the first voucher is verified for a new session
  onSessionOpen: async (channelId) => {
    await db.from('sessions').insert({
      channel_id: channelId,
      status: 'open',
      voucher_count: 0,
    })
  },

  // Fires after each verified ed25519 commitment (off-chain, no tx fee)
  onVoucher: async (voucherIndex, cumulativeAmount) => {
    await db.from('sessions').update({
      voucher_count: voucherIndex,
      cumulative_amount: parseFloat(cumulativeAmount),
    }).eq('channel_id', channelId)
  },

  // Fires after the on-chain channel close settles the cumulative amount
  onSettled: async (txHash, totalPaid, mode) => {
    await db.from('sessions').update({
      status: 'closed',
      settlement_tx_hash: txHash,
    }).eq('channel_id', channelId)
  },
}))
```

| Hook | When it fires | On-chain? |
|---|---|---|
| `onSessionOpen(channelId)` | First verified voucher in a new session | No |
| `onVoucher(index, cumulativeAmount)` | Each verified ed25519 commitment | No |
| `onSettled(txHash, amount, mode)` | Channel close transaction confirmed | Yes |

## Mode Selection Logic

The `ModeRouter` uses this decision tree (deterministic, no randomness):

1. If `{ sustained: true }` passed AND manifest supports `mpp-session` → session
2. Else if manifest supports `mpp-charge` AND network is Stellar → MPP charge (lower fees)
3. Else if manifest supports `x402` → x402 with facilitator
4. Else throw `RouteDockNoSupportedModeError`

Override with `{ forceMode: 'x402' }` to bypass auto-selection.

## Security

The `one-way-channel` Soroban contract wrapped by `MppSessionClient` is **unaudited** (`stellar-experimental/one-way-channel`). Safe defaults are enforced: 17280 ledger refund window, monotonic cumulative enforcement at application, database, and contract layers. Production mainnet use should await a formal audit.

## License

MIT
