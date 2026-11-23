/**
 * Agent vault custody mode (#721).
 *
 * The AgentVault contract account (`C...`) declares `type Signature = BytesN<64>`,
 * so its `__check_auth` expects the credential signature to be the raw 64-byte
 * ed25519 signature of the agent key — not the `Vec[Map{public_key, signature}]`
 * stellar-sdk writes for `G...` accounts, which aborts the host before any policy
 * runs. This module builds that credential and the signer that carries it.
 */
import { Address, Keypair, StrKey, hash, xdr } from '@stellar/stellar-sdk'
import type { SigningCallback } from '@stellar/stellar-sdk'
import type { ClientStellarSigner } from '@x402/stellar'
import type { RouteDockManifest } from '../types.js'
import { RouteDockManifestError, RouteDockPolicyRejectError } from '../errors.js'

export interface AgentVaultConfig {
  mode: 'agent-vault'
  /** AgentVault contract account (C...) that pays and whose `__check_auth` enforces the spend policies */
  vaultContract: string
  /** The agent's ed25519 key (S... secret or Keypair) registered on the vault as `agent_pk` */
  agentSecret: string | Keypair
}

/**
 * Global-registry symbol set on signers from {@link createAgentVaultSigner}, so the
 * x402 client can pick the vault scheme without importing the signer factory.
 */
export const AGENT_VAULT_SIGNER_MARKER = Symbol.for('routedock.agent-vault.signer')

export interface AgentVaultStellarSigner extends ClientStellarSigner {
  readonly [AGENT_VAULT_SIGNER_MARKER]: 'agent-vault'
}

export function isAgentVaultStellarSigner(signer: object): signer is AgentVaultStellarSigner {
  return (signer as Partial<AgentVaultStellarSigner>)[AGENT_VAULT_SIGNER_MARKER] === 'agent-vault'
}

/** Raw ed25519 signature length the vault's `Signature = BytesN<64>` accepts. */
const ED25519_SIGNATURE_BYTES = 64

function toKeypair(agentSecret: string | Keypair): Keypair {
  if (typeof agentSecret !== 'string') return agentSecret
  try {
    return Keypair.fromSecret(agentSecret)
  } catch (cause) {
    throw new RouteDockManifestError('agent-vault agentSecret is not a valid Stellar secret key (S...)', {
      cause,
    })
  }
}

/** Fail fast on a malformed vault config. Never echoes the secret. */
export function assertAgentVaultConfig(vault: AgentVaultConfig): void {
  if (typeof vault.vaultContract !== 'string' || !StrKey.isValidContract(vault.vaultContract)) {
    throw new RouteDockManifestError(
      'agent-vault vaultContract must be a Soroban contract address (C... strkey)',
    )
  }
  toKeypair(vault.agentSecret)
}

/** The provider and the client must agree on custody mode and network. */
export function assertAgentVaultManifest(
  manifest: RouteDockManifest,
  network: 'testnet' | 'mainnet',
): void {
  if (manifest.vault !== undefined && manifest.vault !== 'agent-vault') {
    throw new RouteDockManifestError(
      `Provider vault mode ${manifest.vault} does not match client agent-vault`,
    )
  }
  if (manifest.network !== network) {
    throw new RouteDockManifestError(
      `Provider network ${manifest.network} does not match client network ${network}`,
    )
  }
}

/**
 * Authorize a Soroban auth entry for an AgentVault contract account.
 *
 * Same parameter list as stellar-sdk's `authorizeEntry`, so it can be passed to
 * `AssembledTransaction.signAuthEntries` as its `authorizeEntry` override. The
 * preimage is built exactly as stellar-sdk builds it; the only difference is the
 * credential: `scvBytes(signature)` (64 bytes) instead of the `{public_key,
 * signature}` vec.
 *
 * `signer` is the agent `Keypair`, or a callback that returns the signature over
 * `sha256(preimage)` as bytes (or `{ signature, publicKey }`).
 */
export async function agentVaultAuthorizeEntry(
  entry: xdr.SorobanAuthorizationEntry,
  signer: SigningCallback | Keypair,
  validUntilLedgerSeq: number,
  networkPassphrase?: string,
): Promise<xdr.SorobanAuthorizationEntry> {
  if (entry.credentials().switch() !== xdr.SorobanCredentialsType.sorobanCredentialsAddress()) {
    return entry
  }
  if (!networkPassphrase) {
    throw new TypeError('agentVaultAuthorizeEntry needs the network passphrase to build the preimage')
  }

  const clone = xdr.SorobanAuthorizationEntry.fromXDR(entry.toXDR())
  const credentials = clone.credentials().address()
  const address = Address.fromScAddress(credentials.address()).toString()
  if (!address.startsWith('C')) {
    throw new TypeError(
      `agentVaultAuthorizeEntry signs agent vault contract accounts (C...) only, got ${address}`,
    )
  }

  credentials.signatureExpirationLedger(validUntilLedgerSeq)
  const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: hash(Buffer.from(networkPassphrase)),
      nonce: credentials.nonce(),
      invocation: clone.rootInvocation(),
      signatureExpirationLedger: credentials.signatureExpirationLedger(),
    }),
  )
  const payload = hash(preimage.toXDR())

  let signature: Buffer
  if (typeof signer === 'function') {
    const signed = await signer(preimage)
    signature = Buffer.from(signed !== null && typeof signed === 'object' && 'signature' in signed
      ? (signed as { signature: Uint8Array }).signature
      : (signed as unknown as Uint8Array))
  } else {
    signature = Buffer.from(signer.sign(payload))
  }

  if (signature.length !== ED25519_SIGNATURE_BYTES) {
    throw new TypeError(
      `agent vault signature must be ${ED25519_SIGNATURE_BYTES} bytes, got ${signature.length}`,
    )
  }
  credentials.signature(xdr.ScVal.scvBytes(signature))
  return clone
}

/**
 * Signer that pays from the vault (`address` is the `C...` contract) and signs
 * with the agent key. `signAuthEntry` signs `sha256(preimage)` like stellar-sdk's
 * `basicNodeSigner`, returning the raw 64-byte signature.
 */
export function createAgentVaultSigner(vault: AgentVaultConfig): AgentVaultStellarSigner {
  assertAgentVaultConfig(vault)
  const keypair = toKeypair(vault.agentSecret)
  return {
    address: vault.vaultContract,
    signAuthEntry: async (authEntry: string) => ({
      signedAuthEntry: Buffer.from(
        keypair.sign(hash(Buffer.from(authEntry, 'base64'))),
      ).toString('base64'),
    }),
    [AGENT_VAULT_SIGNER_MARKER]: 'agent-vault',
  }
}

// ── Vault contract errors ────────────────────────────────────────────────────

/** Vault `Error` codes that mean a spend policy refused the payment. */
const VAULT_POLICY_REASONS: Readonly<Record<number, string>> = {
  3: 'vault_session_expired',
  4: 'vault_daily_cap_exceeded',
  5: 'vault_payee_not_allowed',
  9: 'vault_frozen',
}

/** A simulated `__check_auth` failure the vault reports as a policy rejection. */
export class AgentVaultPolicyError extends Error {
  readonly code: number
  readonly reason: string

  constructor(code: number, reason: string, options?: { cause?: unknown }) {
    super(`agent vault rejected the payment: ${reason} (Error(Contract, #${code}))`, options)
    this.name = 'AgentVaultPolicyError'
    this.code = code
    this.reason = reason
  }
}

/** Read `Error(Contract, #N)` out of a simulation error and map it, if it is a policy code. */
export function mapAgentVaultSimulationError(err: unknown): AgentVaultPolicyError | undefined {
  if (err instanceof AgentVaultPolicyError) return err
  const message = err instanceof Error ? err.message : String(err)
  const match = /Error\(Contract, #(\d+)\)/.exec(message)
  if (!match) return undefined
  const code = Number(match[1])
  const reason = VAULT_POLICY_REASONS[code]
  return reason === undefined ? undefined : new AgentVaultPolicyError(code, reason, { cause: err })
}

/**
 * Find a vault policy error anywhere in an error's cause chain (the x402 client
 * wraps signing failures) and return it as the SDK's typed policy rejection.
 */
export function toAgentVaultPolicyReject(err: unknown): RouteDockPolicyRejectError | undefined {
  const seen = new Set<unknown>()
  for (let current: unknown = err; current && !seen.has(current); ) {
    seen.add(current)
    if (current instanceof AgentVaultPolicyError) {
      return new RouteDockPolicyRejectError(current.reason, { cause: err })
    }
    current = current instanceof Error ? current.cause : undefined
  }
  return undefined
}
