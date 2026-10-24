/** Nulth vault integration backed by the shared Nulth SDK. */
import { rpc } from '@stellar/stellar-sdk'
import type { ClientStellarSigner } from '@x402/stellar'
import {
  NulthConfigError,
  createNulthSigner as createSharedNulthSigner,
  createPolicyState,
  paymentContextFromManifest,
  setNulthPaymentContext,
  type NulthSignerConfig,
  type NulthStellarSigner,
} from '@routedock/nulth-sdk'
import type { RouteDockManifest, PaymentMode, VaultMode } from '../types.js'
import { RouteDockManifestError } from '../errors.js'
import { resolveLogger } from '../internal/logger.js'

export {
  NulthPolicyError,
  createPolicyState,
  decodeAuthSignature,
  paymentContextFromManifest,
  setNulthPaymentContext,
} from '@routedock/nulth-sdk'
export type {
  NulthAuthSignature,
  NulthClientConfig,
  NulthPolicyState,
  NulthProof,
  NulthSignerConfig,
  NulthStellarSigner,
  PaymentAuthContext,
} from '@routedock/nulth-sdk'

/** Preserve RouteDock's logger default and configuration error contract. */
export function createNulthSigner(config: NulthSignerConfig): NulthStellarSigner {
  const sharedConfig = { ...config, logger: resolveLogger(config.logger) }
  // The caller can replace the payment context after creating the signer.
  Object.defineProperty(sharedConfig, 'paymentContext', {
    get: () => config.paymentContext,
  })
  try {
    return createSharedNulthSigner(sharedConfig)
  } catch (error) {
    if (error instanceof NulthConfigError) {
      throw new RouteDockManifestError(error.message, { cause: error })
    }
    throw error
  }
}

export interface NulthVaultConfig {
  mode: 'nulth'
  nulthAccount: string
  prover?: 'mock'
  witnessSecret: string
  allowedPayees: readonly string[]
  dailyCapUsdc: string
  expiryLedger?: number
  verifierContract?: string
}

export function assertNulthVaultManifest(manifest: RouteDockManifest, nulthAccount: string): void {
  if (manifest.vault !== undefined && manifest.vault !== 'nulth') {
    throw new RouteDockManifestError(`Provider vault mode ${manifest.vault} does not match client nulth vault`)
  }
  if (manifest.nulth_account && manifest.nulth_account !== nulthAccount) {
    throw new RouteDockManifestError(`Manifest nulth_account ${manifest.nulth_account} does not match configured ${nulthAccount}`)
  }
}

export async function fetchLedgerSequence(network: 'testnet' | 'mainnet'): Promise<number> {
  const rpcUrl = network === 'testnet'
    ? 'https://soroban-testnet.stellar.org'
    : 'https://soroban.stellar.org'
  const server = new rpc.Server(rpcUrl)
  const latest = await server.getLatestLedger()
  return latest.sequence
}

export async function prepareNulthSigner(
  vault: NulthVaultConfig,
  manifest: RouteDockManifest,
  mode: PaymentMode,
  network: 'testnet' | 'mainnet',
  ledgerSequenceOverride?: number,
): Promise<{ signer: ClientStellarSigner; config: NulthSignerConfig }> {
  assertNulthVaultManifest(manifest, vault.nulthAccount)

  const prover = vault.prover ?? 'mock'
  if (network === 'mainnet' && prover === 'mock') {
    throw new RouteDockManifestError(
      'nulth vault uses the insecure mock prover and cannot be used on mainnet',
    )
  }

  const ledgerSequence = ledgerSequenceOverride ?? (await fetchLedgerSequence(network))
  const policy = createPolicyState({
    dailyCapUsdc: vault.dailyCapUsdc,
    allowedPayees: vault.allowedPayees,
    witnessSecret: vault.witnessSecret,
    ledgerSequence,
    ...(vault.expiryLedger !== undefined ? { expiryLedger: vault.expiryLedger } : {}),
  })

  const config: NulthSignerConfig = {
    nulthAccount: vault.nulthAccount,
    network,
    prover,
    policy,
    ...(vault.verifierContract !== undefined ? { verifierContract: vault.verifierContract } : {}),
  }

  if (mode === 'x402' || mode === 'mpp-charge') {
    setNulthPaymentContext(config, paymentContextFromManifest(manifest, mode, ledgerSequence))
  } else {
    throw new RouteDockManifestError(`Nulth ZK vault does not support payment mode: ${mode}`)
  }

  const signer = createNulthSigner(config)
  return { signer, config }
}

export type { VaultMode }
