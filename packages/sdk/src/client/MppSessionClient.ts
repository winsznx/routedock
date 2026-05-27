/**
 * MppSessionClient — uses @stellar/mpp channel/client for off-chain
 * cumulative commitments against a pre-deployed one-way-channel contract.
 *
 * The channel is deployed and funded before the agent runs. The client
 * signs ed25519 commitments per the one-way-channel protocol — the
 * @stellar/mpp library handles the 402 challenge-response cycle.
 */
import { Keypair } from '@stellar/stellar-sdk'
import { stellar } from '@stellar/mpp/channel/client'
import { Mppx } from 'mppx/client'
import type {
  RouteDockManifest,
  SessionHandle,
  SessionCloseResult,
} from '../types.js'
import {
  RouteDockManifestError,
  RouteDockChannelStateError,
  RouteDockSignatureError,
  httpStatusToError,
  wrapFetchError,
} from '../errors.js'
import { withRetry, type RetryPolicy } from '../internal/retry.js'

const MIN_REFUND_WAITING_PERIOD = 17_280

export class MppSessionClient {
  constructor(
    private readonly keypair: Keypair,
    private readonly network: 'testnet' | 'mainnet',
    private readonly retryPolicy?: RetryPolicy,
  ) {}

  async openSession(
    url: string,
    manifest: RouteDockManifest,
    commitmentSecret: string,
  ): Promise<SessionHandle> {
    const pricing = manifest.pricing['mpp-session']
    if (!pricing) {
      throw new RouteDockManifestError('manifest.pricing.mpp-session missing')
    }

    const refundPeriod = pricing.refund_waiting_period_ledgers
    if (refundPeriod < MIN_REFUND_WAITING_PERIOD) {
      throw new RouteDockManifestError(
        `refund_waiting_period_ledgers ${refundPeriod} < minimum ${MIN_REFUND_WAITING_PERIOD}`,
      )
    }

    const commitmentKey = Keypair.fromSecret(commitmentSecret)
    const channelContract = pricing.channel_contract
    const agentPublicKey = this.keypair.publicKey()

    let currentCumulative = 0n
    let vouchersIssued = 0

    const mppx = Mppx.create({
      polyfill: false,
      methods: [
        stellar.channel({
          commitmentKey,
          sourceAccount: this.keypair.publicKey(),
          onProgress(event) {
            if (event.type === 'signed') {
              currentCumulative = BigInt(event.cumulativeAmount)
            }
          },
        }),
      ],
    })

    const openTxHash = channelContract
    const retryPolicy = this.retryPolicy

    const handle: SessionHandle = {
      channelId: channelContract,
      openTxHash,

      async *stream(): AsyncIterable<unknown> {
        while (true) {
          const data = await withRetry(async () => {
            let resp: Response
            try {
              resp = await mppx.fetch(url)
            } catch (err) {
              throw wrapFetchError(err, 'Voucher request')
            }

            if (!resp.ok) {
              if (resp.status >= 500 || resp.status === 429 || resp.status === 503) {
                throw httpStatusToError(
                  `Voucher request failed: HTTP ${resp.status}`,
                  resp.status,
                  resp,
                )
              }
              throw new RouteDockChannelStateError(
                `Voucher request failed: HTTP ${resp.status}`,
              )
            }

            return resp.json()
          }, retryPolicy)

          vouchersIssued++
          yield data
        }
      },

      async close(): Promise<SessionCloseResult> {
        const { rpc: rpcMod, Contract, nativeToScVal, TransactionBuilder, BASE_FEE } =
          await import('@stellar/stellar-sdk')
        const rpcUrl = 'https://soroban-testnet.stellar.org'
        const server = new rpcMod.Server(rpcUrl)
        const contract = new Contract(channelContract)
        const passphrase = 'Test SDF Network ; September 2015'

        const account = await withRetry(async () => {
          try {
            return await server.getAccount(agentPublicKey)
          } catch (err) {
            throw wrapFetchError(err, 'Horizon getAccount')
          }
        }, retryPolicy)

        const simResult = await withRetry(async () => {
          try {
            const simTx = new TransactionBuilder(account, {
              fee: BASE_FEE,
              networkPassphrase: passphrase,
            })
              .addOperation(
                contract.call(
                  'prepare_commitment',
                  nativeToScVal(currentCumulative, { type: 'i128' }),
                ),
              )
              .setTimeout(30)
              .build()
            return await server.simulateTransaction(simTx)
          } catch (err) {
            throw wrapFetchError(err, 'prepare_commitment RPC')
          }
        }, retryPolicy)

        if (rpcMod.Api.isSimulationError(simResult)) {
          throw new RouteDockChannelStateError(
            `prepare_commitment simulation failed: ${simResult.error}`,
          )
        }

        const commitmentBytes = (
          simResult as { result?: { retval?: { bytes: () => Buffer } } }
        ).result?.retval?.bytes()
        if (!commitmentBytes) {
          throw new RouteDockChannelStateError('prepare_commitment returned no bytes')
        }

        let signature: Buffer
        try {
          signature = commitmentKey.sign(Buffer.from(commitmentBytes))
        } catch (err) {
          throw new RouteDockSignatureError('Channel close commitment signing failed', {
            cause: err,
          })
        }

        const closeData = await withRetry(async () => {
          let closeResp: Response
          try {
            closeResp = await fetch(url, {
              method: 'DELETE',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                amount: currentCumulative.toString(),
                signature: Buffer.from(signature).toString('hex'),
              }),
            })
          } catch (err) {
            throw wrapFetchError(err, 'Channel close request')
          }

          if (!closeResp.ok) {
            if (
              closeResp.status >= 500 ||
              closeResp.status === 429 ||
              closeResp.status === 503
            ) {
              throw httpStatusToError(
                `Channel close failed: HTTP ${closeResp.status}`,
                closeResp.status,
                closeResp,
              )
            }
            throw new RouteDockChannelStateError(
              `Channel close failed: HTTP ${closeResp.status}`,
            )
          }

          const body = (await closeResp.json()) as { closeTxHash?: string }
          const closeTxHash = body.closeTxHash ?? null
          if (!closeTxHash) {
            throw new RouteDockChannelStateError(
              'Channel close response missing closeTxHash',
            )
          }
          return { closeTxHash, body }
        }, retryPolicy)

        const totalPaid = (Number(currentCumulative) / 1e7).toFixed(7)
        return {
          closeTxHash: closeData.closeTxHash,
          totalPaid,
          vouchersIssued,
        }
      },
    }

    return handle
  }
}
