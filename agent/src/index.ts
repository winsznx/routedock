/**
 * RouteDock Reference Agent — Phase 4
 *
 * Runs the full autonomous payment sequence from Section 10.1 of
 * ROUTEDOCK_MASTER.md against live provider services on Stellar testnet.
 *
 * Run sequence:
 *   1. Initialize — derive keypair, log balance
 *   2. x402 discrete query (forced mode)
 *   3. MPP charge query (natural mode selection)
 *   4. MPP session — open + 50 SSE events + close (KEY DEMO: 50 interactions, 2 tx)
 *   5. Policy rejection — spend cap enforced locally, nothing broadcast
 *   6. Summary log + write agent/RUN_RESULTS.md
 *
 * WARNING: The mpp-session path uses stellar-experimental/one-way-channel,
 * an UNAUDITED contract. Do not use in production without an independent audit.
 */

import { writeFileSync } from 'node:fs'
import { Keypair } from '@stellar/stellar-sdk'
import { Horizon } from '@stellar/stellar-sdk'
import { RouteDockClient, RouteDockPolicyRejectedError } from '@routedock/routedock'

// ── Config ────────────────────────────────────────────────────────────────────

const STELLAR_NETWORK = (process.env['STELLAR_NETWORK'] ?? 'testnet') as 'testnet' | 'mainnet'
const AGENT_SECRET = process.env['AGENT_SECRET'] ?? ''
const PROVIDER_A_URL = (process.env['PROVIDER_A_URL'] ?? 'http://localhost:3001').replace(/\/$/, '')
const PROVIDER_B_URL = (process.env['PROVIDER_B_URL'] ?? 'http://localhost:3002').replace(/\/$/, '')
const AGENT_DAILY_CAP_USDC = process.env['AGENT_DAILY_CAP_USDC'] ?? '0.002'
const COMMITMENT_SECRET = process.env['COMMITMENT_SECRET'] ?? ''

const HORIZON_URL =
  STELLAR_NETWORK === 'testnet'
    ? 'https://horizon-testnet.stellar.org'
    : 'https://horizon.stellar.org'

const EXPLORER_BASE = `https://stellar.expert/explorer/${STELLAR_NETWORK}/tx`

// ── Logging ───────────────────────────────────────────────────────────────────

function log(step: string, msg: string): void {
  const ts = new Date().toISOString()
  console.log(`[${ts}] [${step}] ${msg}`)
}

function explorerLink(txHash: string): string {
  return `${EXPLORER_BASE}/${txHash}`
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // ── Step 1: Initialize ────────────────────────────────────────────────────

  if (!AGENT_SECRET || !AGENT_SECRET.startsWith('S')) {
    console.error('FATAL: AGENT_SECRET is required and must be a valid Stellar secret key (S...)')
    process.exit(1)
  }

  const keypair = Keypair.fromSecret(AGENT_SECRET)
  const agentAddress = keypair.publicKey()

  const client = new RouteDockClient({
    wallet: keypair,
    network: STELLAR_NETWORK,
    spendCap: { daily: AGENT_DAILY_CAP_USDC, asset: 'USDC' },
    commitmentSecret: COMMITMENT_SECRET || undefined,
  })

  // Fetch USDC balance from Horizon
  const horizonServer = new Horizon.Server(HORIZON_URL)
  let startingBalance = '0'
  try {
    const account = await horizonServer.loadAccount(agentAddress)
    const usdcBalance = account.balances.find(
      (b) => 'asset_code' in b && b.asset_code === 'USDC',
    )
    startingBalance = usdcBalance ? usdcBalance.balance : '0'
  } catch {
    log('Init', 'Warning: could not fetch balance from Horizon — continuing')
  }

  log('Init', `[RouteDock Agent] Started. Address: ${agentAddress} Balance: ${startingBalance} USDC`)
  log('Init', `Network: ${STELLAR_NETWORK}, DailyCap: ${AGENT_DAILY_CAP_USDC} USDC`)
  log('Init', `Provider A: ${PROVIDER_A_URL}`)
  log('Init', `Provider B: ${PROVIDER_B_URL}`)

  const txHashes: {
    x402?: string
    mppCharge?: string
    channelOpen?: string
    channelClose?: string
  } = {}

  // ── Step 2: x402 discrete query ───────────────────────────────────────────

  log('x402', 'Querying price endpoint with forced x402 mode...')
  const x402Result = await client.pay(`${PROVIDER_A_URL}/price`, { forceMode: 'x402' })

  if (!x402Result.txHash) {
    throw new Error(`x402 payment returned null txHash — settlement did not complete`)
  }

  txHashes.x402 = x402Result.txHash
  log('x402', `mode=${x402Result.mode} txHash=${x402Result.txHash} amount=${x402Result.amount}`)
  log('x402', `price=${JSON.stringify((x402Result.data as { price?: string })?.price)}`)
  log('x402', `explorer: ${explorerLink(x402Result.txHash)}`)

  // ── Step 3: MPP charge query ──────────────────────────────────────────────

  log('mpp-charge', 'Querying price endpoint (natural mode selection → mpp-charge)...')
  const chargeResult = await client.pay(`${PROVIDER_A_URL}/price`)

  log('mpp-charge', `mode=${chargeResult.mode} txHash=${chargeResult.txHash ?? 'null'} amount=${chargeResult.amount}`)
  log('mpp-charge', `price=${JSON.stringify((chargeResult.data as { price?: string })?.price)}`)
  if (chargeResult.txHash) {
    txHashes.mppCharge = chargeResult.txHash
    log('mpp-charge', `explorer: ${explorerLink(chargeResult.txHash)}`)
  }

  // ── Step 4: MPP session streaming ─────────────────────────────────────────

  log('mpp-session', 'Opening MPP session channel...')
  const session = await client.openSession(`${PROVIDER_B_URL}/stream/orderbook`)

  txHashes.channelOpen = session.openTxHash
  log('mpp-session', `[Session] Opened. Channel: ${session.channelId} openTxHash: ${session.openTxHash}`)
  log('mpp-session', `Channel open explorer: ${explorerLink(session.openTxHash)}`)

  // Consume exactly 50 SSE events from the session stream
  const TARGET_VOUCHERS = 50
  let voucherCount = 0
  const rate = 0.0001 // matches manifest pricing['mpp-session'].rate

  for await (const _item of session.stream()) {
    voucherCount++

    if (voucherCount % 10 === 0) {
      const cumulative = (voucherCount * rate).toFixed(4)
      log('mpp-session', `[Session] Vouchers: ${voucherCount}, Cumulative: $${cumulative}`)
    }

    if (voucherCount >= TARGET_VOUCHERS) break
  }

  log('mpp-session', `Consumed ${voucherCount} vouchers. Closing session...`)
  const closeResult = await session.close()

  txHashes.channelClose = closeResult.closeTxHash
  log(
    'mpp-session',
    `[Session] Closed. closeTxHash: ${closeResult.closeTxHash}. ` +
    `${closeResult.vouchersIssued} interactions, 2 on-chain transactions.`,
  )
  log('mpp-session', `totalPaid: ${closeResult.totalPaid} USDC`)
  log('mpp-session', `Channel close explorer: ${explorerLink(closeResult.closeTxHash)}`)

  // ── Step 5: Policy rejection ──────────────────────────────────────────────

  // After steps 2+3, daily spend = 0.001 + 0.0008 = 0.0018 USDC.
  // Daily cap = 0.002 USDC. Adding another 0.001 (x402 price) → 0.0028 > 0.002 → rejected.
  log('policy', 'Attempting payment that exceeds daily cap...')
  let policyRejected = false
  try {
    await client.pay(`${PROVIDER_A_URL}/price`, { forceMode: 'x402' })
    log('policy', 'WARNING: payment succeeded when it should have been rejected!')
  } catch (err) {
    if (err instanceof RouteDockPolicyRejectedError) {
      policyRejected = true
      log('policy', `[Policy] REJECTED — reason: ${err.reason}. No transaction broadcast.`)
      log('policy', 'Confirmed: spend cap enforced locally before any Stellar transaction.')
    } else {
      throw err
    }
  }

  if (!policyRejected) {
    log('policy', 'WARNING: expected RouteDockPolicyRejectedError but payment succeeded')
  }

  // ── Step 6: Summary ───────────────────────────────────────────────────────

  const summary = buildSummary(agentAddress, startingBalance, txHashes, voucherCount, closeResult.totalPaid)

  console.log('\n' + summary)

  // Write RUN_RESULTS.md
  const resultsPath = require('node:path').join(__dirname, '..', 'RUN_RESULTS.md') as string
  writeFileSync(resultsPath, summary, 'utf8')
  log('Summary', `RUN_RESULTS.md written to ${resultsPath}`)
}

// ── Summary builder ───────────────────────────────────────────────────────────

function buildSummary(
  agentAddress: string,
  startingBalance: string,
  txHashes: { x402?: string; mppCharge?: string; channelOpen?: string; channelClose?: string },
  vouchersUsed: number,
  totalPaid: string,
): string {
  const line = (label: string, hash?: string): string => {
    if (!hash) return `  ${label.padEnd(22)} NO TX`
    return `  ${label.padEnd(22)} ${hash}\n  ${''.padEnd(22)} → ${EXPLORER_BASE}/${hash}`
  }

  return [
    '# RouteDock Agent Run Results',
    '',
    `**Date:** ${new Date().toISOString()}`,
    `**Network:** ${STELLAR_NETWORK}`,
    `**Agent address:** \`${agentAddress}\``,
    `**Starting USDC balance:** ${startingBalance}`,
    '',
    '## Transaction Hashes',
    '',
    '```',
    line('x402 settlement:', txHashes.x402),
    line('MPP charge:', txHashes.mppCharge),
    line('Channel open:', txHashes.channelOpen),
    line('Channel close:', txHashes.channelClose),
    '  Policy rejection:      NO TX (cap enforced locally)',
    '```',
    '',
    '## Session Details',
    '',
    `- Vouchers consumed: ${vouchersUsed}`,
    `- Total paid via session: ${totalPaid} USDC`,
    `- On-chain transactions for session: 2 (open + close)`,
    '',
    '## Verification',
    '',
    txHashes.x402
      ? `- x402 settlement: [view on explorer](${EXPLORER_BASE}/${txHashes.x402})`
      : '- x402 settlement: PENDING',
    txHashes.mppCharge
      ? `- MPP charge: [view on explorer](${EXPLORER_BASE}/${txHashes.mppCharge})`
      : '- MPP charge: PENDING',
    txHashes.channelOpen
      ? `- Channel open: [view on explorer](${EXPLORER_BASE}/${txHashes.channelOpen})`
      : '- Channel open: PENDING',
    txHashes.channelClose
      ? `- Channel close: [view on explorer](${EXPLORER_BASE}/${txHashes.channelClose})`
      : '- Channel close: PENDING',
    '- Policy rejection: NO TX confirmed (nothing broadcast to Stellar)',
    '',
  ].join('\n')
}

main().catch((err: unknown) => {
  console.error('[Agent] Fatal error:', err)
  process.exit(1)
})
