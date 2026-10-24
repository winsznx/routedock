import {
  Account,
  BASE_FEE,
  Contract,
  Keypair,
  Networks,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
} from '@stellar/stellar-sdk'
import type { Server as SorobanServer } from '@stellar/stellar-sdk/rpc'
import { createSorobanRpcServer } from './vaultRpc.js'
import type { RouteDockLogger } from '../../internal/logger.js'
import type { VaultSettlementConfig } from '../../internal/vaultConfig.js'

export type { VaultSettlementConfig } from '../../internal/vaultConfig.js'

export interface VaultSettlementAddresses {
  payer: string
  payee: string
}

/**
 * Return correctly attributed vault-event participants, or null when the
 * payer could not be extracted. Publishing no audit event is safer than
 * knowingly attributing the provider as both sides of the settlement.
 */
export function resolveVaultSettlementAddresses(
  payer: string | null,
  payee: string,
): VaultSettlementAddresses | null {
  if (!payer) return null
  return { payer, payee }
}

/**
 * Build the `record_session_settlement` transaction for a closed channel.
 *
 * The transaction source is the payee, because the vault authorizes the record
 * with the allowlisted payee's own signature — never the vault admin's. The
 * source-account credential added by `prepareTransaction` therefore satisfies
 * `payee.require_auth()` on the contract, so a provider never needs the admin
 * secret to emit `session_settled`.
 *
 * Kept free of RPC calls so it is unit-testable without a network round trip.
 */
export function buildSessionSettlementTransaction(
  source: Account,
  vaultContractId: string,
  channelId: string,
  addresses: VaultSettlementAddresses,
  amount: bigint,
  voucherCount: number,
  networkPassphrase: string,
): Transaction {
  const vault = new Contract(vaultContractId)
  const op = vault.call(
    'record_session_settlement',
    nativeToScVal(channelId, { type: 'address' }),
    nativeToScVal(addresses.payer, { type: 'address' }),
    nativeToScVal(addresses.payee, { type: 'address' }),
    nativeToScVal(amount, { type: 'i128' }),
    nativeToScVal(voucherCount, { type: 'u32' }),
  )
  return new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(op)
    .setTimeout(30)
    .build()
}

/** Default Soroban RPC endpoints when `vaultSettlement.rpcUrl` is unset. */
const DEFAULT_RPC_URLS: Record<'testnet' | 'mainnet', string> = {
  testnet: 'https://soroban-testnet.stellar.org',
  mainnet: 'https://mainnet.sorobanrpc.com',
}

/**
 * The settlement transaction is built with `.setTimeout(30)`, so it can only
 * be included for ~30 ledgers (~2 min). Polling gives up after this long.
 */
const CONFIRM_TIMEOUT_MS = 120_000

/** Delay between `getTransaction` polls while the transaction is pending. */
const CONFIRM_POLL_MS = 1_000

/** Everything `recordSessionSettlement` needs about a closed session. */
export interface RecordSessionSettlementRequest {
  config: VaultSettlementConfig
  network: 'testnet' | 'mainnet'
  /** Payee secret — the vault authorizes the record with the payee's own signature, which is also the tx source. */
  payeeSecretKey: string
  /** The channel contract that was closed. */
  channelId: string
  /** Agent that paid, or null when its address could not be extracted. */
  payer: string | null
  /** Close amount in stroops. */
  amount: bigint
  /** Number of verified vouchers the session received. */
  voucherCount: number
}

export type VaultSettlementResult =
  | { ok: true; txHash: string }
  | { ok: false; reason: string; txHash?: string }

interface VaultSettlementReporting {
  logger: RouteDockLogger
  /** Same hook the mpp-session callbacks use — receives failures only, never a throw. */
  onCallbackError?: ((err: unknown, cbName: string) => void) | undefined
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Best-effort human-readable reason from a sendTransaction ERROR response. */
function describeSendError(sent: { status: string; errorResult?: unknown }): string {
  const errorResult = sent.errorResult as
    | { result?: () => { switch?: () => { name?: string } } }
    | undefined
  try {
    const name = errorResult?.result?.().switch?.().name
    if (name) return `sendTransaction returned ERROR: ${name}`
  } catch {
    // errorResult shape is RPC-version dependent — fall through to the status.
  }
  return `sendTransaction returned status ${sent.status}`
}

type ConfirmationStatus = 'success' | 'failed' | 'timeout'

/** Poll `getTransaction` until the transaction is included, fails, or the deadline passes. */
async function waitForConfirmation(
  server: SorobanServer,
  txHash: string,
): Promise<ConfirmationStatus> {
  const deadline = Date.now() + CONFIRM_TIMEOUT_MS
  for (;;) {
    const tx = await server.getTransaction(txHash)
    if (tx.status === 'SUCCESS') return 'success'
    if (tx.status === 'FAILED') return 'failed'
    if (Date.now() >= deadline) return 'timeout'
    await delay(CONFIRM_POLL_MS)
  }
}

/**
 * Record `session_settled` on the agent vault for a cleanly closed channel:
 * build → prepare → sign → send → confirm.
 *
 * This is the single entry point every adapter (Express, Fastify, Hono) uses,
 * so the whole flow is shared instead of one adapter remembering steps the
 * other drops. It NEVER throws and it never leaves a failure unreported:
 * every failure is logged at `error` level with the transaction hash and
 * reason, and forwarded to `onCallbackError` when one is supplied — matching
 * how the other mpp-session callbacks report problems. Callers can therefore
 * run it without blocking or guarding their close response.
 */
export async function recordSessionSettlement(
  request: RecordSessionSettlementRequest,
  { logger, onCallbackError }: VaultSettlementReporting,
): Promise<VaultSettlementResult> {
  const reportFailure = (fields: {
    reason: string
    txHash?: string
    error?: unknown
  }): VaultSettlementResult => {
    logger('error', '[vault] failed to record session_settled', {
      channelId: request.channelId,
      ...(fields.txHash ? { txHash: fields.txHash } : {}),
      reason: fields.reason,
      ...(fields.error !== undefined ? { error: fields.error } : {}),
    })
    if (onCallbackError) {
      const err =
        fields.error ??
        new Error(`session_settled vault record failed: ${fields.reason}`)
      onCallbackError(err, 'vaultSettlement')
    }
    return { ok: false, reason: fields.reason, ...(fields.txHash ? { txHash: fields.txHash } : {}) }
  }

  try {
    const payeeKeypair = Keypair.fromSecret(request.payeeSecretKey)
    const addresses = resolveVaultSettlementAddresses(request.payer, payeeKeypair.publicKey())
    if (!addresses) {
      // Publishing no audit event is safer than misattributing the provider
      // as both sides of the settlement.
      logger('warn', '[vault] skipped session_settled record: payer address unavailable', {
        channelId: request.channelId,
      })
      return { ok: false, reason: 'payer address unavailable' }
    }

    const networkPassphrase = request.network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET
    const rpcUrl = request.config.rpcUrl ?? DEFAULT_RPC_URLS[request.network]
    const server: SorobanServer = await createSorobanRpcServer(rpcUrl)

    const sourceAccount = await server.getAccount(payeeKeypair.publicKey())
    const tx = buildSessionSettlementTransaction(
      sourceAccount,
      request.config.contract,
      request.channelId,
      addresses,
      request.amount,
      request.voucherCount,
      networkPassphrase,
    )
    const preparedTx = await server.prepareTransaction(tx)
    preparedTx.sign(payeeKeypair)

    const sent = await server.sendTransaction(preparedTx)
    if (sent.status === 'ERROR') {
      return reportFailure({
        txHash: sent.hash || preparedTx.hash().toString('hex'),
        reason: describeSendError(sent),
      })
    }
    const txHash = sent.hash || preparedTx.hash().toString('hex')

    const confirmation = await waitForConfirmation(server, txHash)
    if (confirmation === 'success') {
      logger('debug', '[vault] recorded session_settled', {
        channelId: request.channelId,
        txHash,
      })
      return { ok: true, txHash }
    }
    return reportFailure({
      txHash,
      reason:
        confirmation === 'failed'
          ? 'transaction failed on-chain'
          : `confirmation timed out after ${CONFIRM_TIMEOUT_MS}ms`,
    })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return reportFailure({ reason, error: err })
  }
}
