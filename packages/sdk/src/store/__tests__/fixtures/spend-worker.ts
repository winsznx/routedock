/**
 * Child process for the multi-process spend-cap test (#562).
 *
 * Usage: spend-worker.ts <spendFile> <attempts> <amountUsdc> <dailyCapUsdc> <startAtEpochMs> <walletSecret>
 *
 * Builds a real RouteDockClient on a FileSpendStore pointing at the shared file,
 * waits until `startAtEpochMs` so every worker races at once, then tries to
 * reserve `amountUsdc` `attempts` times (a few in flight at once) and prints
 * `{"granted":n,"rejected":m}`.
 */
import { Keypair } from '@stellar/stellar-sdk'
import { RouteDockClient } from '../../../client/RouteDockClient.js'
import { RouteDockPolicyRejectError } from '../../../errors.js'
import { FileSpendStore } from '../../FileSpendStore.js'

const [spendFile, attemptsArg, amount, dailyCap, startAtArg, walletSecret] = process.argv.slice(2)
if (!spendFile || !attemptsArg || !amount || !dailyCap || !startAtArg || !walletSecret) {
  throw new Error('usage: spend-worker <spendFile> <attempts> <amountUsdc> <dailyCapUsdc> <startAtMs> <walletSecret>')
}

const client = new RouteDockClient({
  wallet: Keypair.fromSecret(walletSecret), // every worker shares one wallet, so one cap
  network: 'testnet',
  spendCap: { daily: dailyCap, asset: 'USDC' },
  spendStore: new FileSpendStore(spendFile),
})
const reserve = (client as unknown as {
  _checkAndReserveSpend(amount: string, endpointKey: string, asset: string): Promise<string>
})._checkAndReserveSpend.bind(client)

let granted = 0
let rejected = 0
const attempts = Number(attemptsArg)

async function attempt(): Promise<void> {
  try {
    await reserve(amount!, 'https://provider.test', 'USDC')
    granted++
  } catch (err) {
    if (err instanceof RouteDockPolicyRejectError) rejected++
    else throw err
  }
}

while (Date.now() < Number(startAtArg)) {
  await new Promise((r) => setTimeout(r, 1))
}

const IN_FLIGHT = 3
let launched = 0
await Promise.all(
  Array.from({ length: IN_FLIGHT }, async () => {
    while (launched < attempts) {
      launched++
      await attempt()
    }
  }),
)

process.stdout.write(JSON.stringify({ granted, rejected }))
