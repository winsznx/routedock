import { contract, nativeToScVal } from '@stellar/stellar-sdk'
import type { AssembledTransaction } from '@stellar/stellar-sdk/contract'
import {
  ExactStellarScheme,
  getEstimatedLedgerCloseTimeSeconds,
  getNetworkPassphrase,
  getRpcClient,
  getRpcUrl,
  handleSimulationResult,
  isStellarNetwork,
  validateStellarAssetAddress,
  validateStellarDestinationAddress,
  type ClientStellarSigner,
} from '@x402/stellar'
import type {
  Network,
  PaymentPayloadResult,
  PaymentRequirements,
  SchemeNetworkClient,
} from '@x402/core/types'
import {
  isNulthStellarSigner,
  nulthAuthorizeEntry,
  type NulthStellarSigner,
} from '@routedock/nulth-sdk'

/**
 * Nulth-aware x402 scheme for Stellar (#552).
 *
 * `ExactStellarScheme` builds the `transfer` transaction correctly for a Nulth
 * payer but signs it with stellar-sdk's default `authorizeEntry`, which reads the
 * credential address as an ed25519 key and therefore throws
 * `invalid version byte. expected 48, got 16` for the `C...` account contract —
 * the proof could never reach the network. Everything else here mirrors the
 * upstream scheme: the transaction, the expiry window, the signer assertions and
 * the re-simulation that widens the footprint to cover `__check_auth`.
 */

/** The transfer the scheme assembles, one field per payment requirement. */
export interface NulthTransfer {
  /** SAC contract holding the funds */
  asset: string
  /** Nulth account contract paying */
  from: string
  payTo: string
  /** Stroops, as the accepted requirement reports them */
  amount: string
  networkPassphrase: string
  rpcUrl: string
}

/** The subset of `AssembledTransaction` the scheme drives. */
export interface NulthPaymentTransaction {
  /** The assembled envelope the payload carries. */
  readonly built?: { toXDR(): string }
  /** The latest simulation, which the resource footprint is read from. */
  readonly simulation?: Parameters<typeof handleSimulationResult>[0]
  /** Accounts holding an address credential that is still unsigned. */
  needsNonInvokerSigningBy(): string[]
  signAuthEntries(options: NulthSignAuthEntriesOptions): Promise<void>
  simulate(): Promise<unknown>
}

/** `AssembledTransaction.signAuthEntries`' options, as the scheme uses them. */
export type NulthSignAuthEntriesOptions = NonNullable<
  Parameters<AssembledTransaction<unknown>['signAuthEntries']>[0]
>

/**
 * The two steps that need a network. They are injectable because a unit test
 * cannot reach Soroban RPC, and the proof-carrying part of the scheme is the
 * credential write, not the round trip.
 */
export interface NulthSchemeIo {
  expirationLedger(network: Network, maxTimeoutSeconds: number): Promise<number>
  assemble(transfer: NulthTransfer): Promise<NulthPaymentTransaction>
}

const defaultIo: NulthSchemeIo = {
  async expirationLedger(network, maxTimeoutSeconds) {
    const { sequence } = await getRpcClient(network).getLatestLedger()
    const secondsPerLedger = await getEstimatedLedgerCloseTimeSeconds(network)
    return sequence + Math.ceil(maxTimeoutSeconds / secondsPerLedger)
  },
  async assemble({ asset, from, payTo, amount, networkPassphrase, rpcUrl }) {
    return contract.AssembledTransaction.build({
      contractId: asset,
      method: 'transfer',
      // SEP-41: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0041.md#interface
      args: [
        nativeToScVal(from, { type: 'address' }),
        nativeToScVal(payTo, { type: 'address' }),
        nativeToScVal(amount, { type: 'i128' }),
      ],
      networkPassphrase,
      rpcUrl,
      parseResultXdr: (result) => result,
    })
  },
}

export class NulthStellarScheme implements SchemeNetworkClient {
  readonly scheme = 'exact'

  constructor(
    private readonly signer: NulthStellarSigner,
    private readonly io: NulthSchemeIo = defaultIo,
  ) {}

  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
  ): Promise<PaymentPayloadResult> {
    try {
      this.validateRequirements(paymentRequirements)
    } catch (err) {
      throw new Error(
        `Invalid input parameters for creating Nulth Stellar payment, cause: ${String(err)}`,
      )
    }

    const from = this.signer.address
    const { network, payTo, asset, amount, maxTimeoutSeconds } = paymentRequirements
    if (!paymentRequirements.extra.areFeesSponsored) {
      throw new Error('Nulth exact scheme requires areFeesSponsored to be true')
    }

    const maxLedger = await this.io.expirationLedger(network, maxTimeoutSeconds)
    const tx = await this.io.assemble({
      asset,
      from,
      payTo,
      amount,
      networkPassphrase: getNetworkPassphrase(network),
      rpcUrl: getRpcUrl(network),
    })

    handleSimulationResult(tx.simulation)

    const signers = tx.needsNonInvokerSigningBy()
    if (!signers.includes(from) || signers.length > 1) {
      throw new Error(`Expected to sign with [${from}], but got [${signers.join(', ')}]`)
    }

    await tx.signAuthEntries({
      address: from,
      signAuthEntry: this.signer.signAuthEntry,
      expiration: maxLedger,
      authorizeEntry: nulthAuthorizeEntry,
    } satisfies NulthSignAuthEntriesOptions)

    await tx.simulate()
    handleSimulationResult(tx.simulation)

    const remaining = tx.needsNonInvokerSigningBy()
    if (remaining.length > 0) {
      throw new Error(`unexpected signer(s) required: [${remaining.join(', ')}]`)
    }
    if (!tx.built) {
      throw new Error('Nulth payment transaction has no assembled envelope to send')
    }

    return { x402Version, payload: { transaction: tx.built.toXDR() } }
  }

  private validateRequirements(requirements: PaymentRequirements): void {
    const { scheme, network, payTo, asset, amount } = requirements
    if (typeof amount !== 'string' || !Number.isInteger(Number(amount)) || Number(amount) <= 0) {
      throw new Error(`Invalid amount: ${amount}. Amount must be a positive integer.`)
    }
    if (scheme !== this.scheme) {
      throw new Error(`Unsupported scheme: ${scheme}`)
    }
    if (!isStellarNetwork(network)) {
      throw new Error(`Unsupported Stellar network: ${network}`)
    }
    if (!validateStellarDestinationAddress(payTo)) {
      throw new Error(`Invalid Stellar destination address: ${payTo}`)
    }
    if (!validateStellarAssetAddress(asset)) {
      throw new Error(`Invalid Stellar asset address: ${asset}`)
    }
  }
}

/**
 * Choose the scheme for a signer. A signer from `createNulthSigner` carries the
 * Nulth marker and pays from a contract account, so it must not be wrapped in the
 * stock ed25519 scheme; every other signer keeps `ExactStellarScheme` unchanged.
 */
export function selectStellarScheme(signer: ClientStellarSigner): SchemeNetworkClient {
  return isNulthStellarSigner(signer)
    ? new NulthStellarScheme(signer as NulthStellarSigner)
    : new ExactStellarScheme(signer)
}
