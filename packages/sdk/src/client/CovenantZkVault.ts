import { rpc } from '@stellar/stellar-sdk'
import type { ClientStellarSigner } from '@x402/stellar'
import {
  createCovenantSigner,
  createPolicyState,
  paymentContextFromManifest,
  setCovenantPaymentContext,
  type CovenantSignerConfig,
} from '@routedock/covenant-sdk'
import type { RouteDockManifest, PaymentMode, VaultMode } from '../types.js'
import { RouteDockManifestError } from '../errors.js'

export interface CovenantZkVaultConfig {
  mode: 'covenant-zk'
  /** Covenant smart account contract address (C...) — the payer */
  covenantAccount: string
  /** Off-chain witness secret for proof binding (never published) */
  witnessSecret: string
  /** Payees the agent may pay — kept off-chain, enforced via ZK proof */
  allowedPayees: readonly string[]
  /** Daily spend cap in USDC decimal string */
  dailyCapUsdc: string
  /** Optional session expiry ledger */
  expiryLedger?: number
  /** Optional on-chain verifier contract */
  verifierContract?: string
}

/** Validate manifest declares covenant-zk vault compatibility */
export function assertCovenantVaultManifest(
  manifest: RouteDockManifest,
  covenantAccount: string,
): void {
  if (manifest.vault !== undefined && manifest.vault !== 'covenant-zk') {
    throw new RouteDockManifestError(
      `Provider vault mode ${manifest.vault} does not match client covenant-zk vault`,
    )
  }
  if (manifest.covenant_account && manifest.covenant_account !== covenantAccount) {
    throw new RouteDockManifestError(
      `Manifest covenant_account ${manifest.covenant_account} does not match configured ${covenantAccount}`,
    )
  }
}

/** Fetch current ledger sequence for day-bucket policy checks */
export async function fetchLedgerSequence(network: 'testnet' | 'mainnet'): Promise<number> {
  const rpcUrl =
    network === 'testnet'
      ? 'https://soroban-testnet.stellar.org'
      : 'https://soroban.stellar.org'
  const server = new rpc.Server(rpcUrl)
  const latest = await server.getLatestLedger()
  return latest.sequence
}

/**
 * Build an x402-compatible Covenant signer for the next payment.
 * Sets payment context so signAuthEntry produces a ZK proof auth signature.
 */
export async function prepareCovenantSigner(
  vault: CovenantZkVaultConfig,
  manifest: RouteDockManifest,
  mode: PaymentMode,
  network: 'testnet' | 'mainnet',
  ledgerSequenceOverride?: number,
): Promise<{ signer: ClientStellarSigner; config: CovenantSignerConfig }> {
  assertCovenantVaultManifest(manifest, vault.covenantAccount)

  const ledgerSequence = ledgerSequenceOverride ?? (await fetchLedgerSequence(network))
  const policy = createPolicyState({
    dailyCapUsdc: vault.dailyCapUsdc,
    allowedPayees: vault.allowedPayees,
    witnessSecret: vault.witnessSecret,
    ledgerSequence,
    ...(vault.expiryLedger !== undefined ? { expiryLedger: vault.expiryLedger } : {}),
  })

  const config: CovenantSignerConfig = {
    covenantAccount: vault.covenantAccount,
    policy,
    ...(vault.verifierContract !== undefined
      ? { verifierContract: vault.verifierContract }
      : {}),
  }

  if (mode === 'x402' || mode === 'mpp-charge') {
    setCovenantPaymentContext(
      config,
      paymentContextFromManifest(manifest, mode, ledgerSequence),
    )
  } else {
    throw new RouteDockManifestError(
      `Covenant ZK vault does not support payment mode: ${mode}`,
    )
  }

  const signer = createCovenantSigner(config)
  return { signer: signer as ClientStellarSigner, config }
}

export type { VaultMode }
