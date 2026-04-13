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
  RouteDockSessionError,
} from '../types.js'

const MIN_REFUND_WAITING_PERIOD = 17_280

export class MppSessionClient {
  constructor(
    private readonly keypair: Keypair,
    private readonly network: 'testnet' | 'mainnet',
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

    const handle: SessionHandle = {
      channelId: channelContract,
      openTxHash,

      async *stream(): AsyncIterable<unknown> {
        while (true) {
          let resp: globalThis.Response | null = null
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              resp = await mppx.fetch(url)
              if (resp.ok) break
              resp = null
            } catch {
              if (attempt === 2) throw new RouteDockSessionError('Voucher request failed after 3 retries')
              await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
            }
          }
          if (!resp || !resp.ok) {
            throw new RouteDockSessionError(`Voucher request failed: HTTP ${resp?.status ?? 'unknown'}`)
          }
          vouchersIssued++
          yield await resp.json()
        }
      },

      async close(): Promise<SessionCloseResult> {
        const { rpc: rpcMod, Contract, nativeToScVal, TransactionBuilder, BASE_FEE } = await import('@stellar/stellar-sdk')
        const rpcUrl = 'https://soroban-testnet.stellar.org'
        const server = new rpcMod.Server(rpcUrl)
        const contract = new Contract(channelContract)
        const passphrase = 'Test SDF Network ; September 2015'

        const account = await server.getAccount(agentPublicKey)
        const simTx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase: passphrase })
          .addOperation(contract.call('prepare_commitment', nativeToScVal(currentCumulative, { type: 'i128' })))
          .setTimeout(30)
          .build()
        const simResult = await server.simulateTransaction(simTx)
        if (rpcMod.Api.isSimulationError(simResult)) {
          throw new RouteDockSessionError(`prepare_commitment simulation failed: ${simResult.error}`)
        }
        const commitmentBytes = (simResult as { result?: { retval?: { bytes: () => Buffer } } }).result?.retval?.bytes()
        if (!commitmentBytes) throw new RouteDockSessionError('prepare_commitment returned no bytes')

        const signature = commitmentKey.sign(Buffer.from(commitmentBytes))

        const closeResp = await fetch(url, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            amount: currentCumulative.toString(),
            signature: Buffer.from(signature).toString('hex'),
          }),
        })

        if (!closeResp.ok) {
          throw new RouteDockSessionError(`Channel close failed: HTTP ${closeResp.status}`)
        }

        const closeData = (await closeResp.json()) as { closeTxHash?: string }
        const closeTxHash = closeData.closeTxHash ?? null

        if (!closeTxHash) {
          throw new RouteDockSessionError('Channel close response missing closeTxHash')
        }

        const totalPaid = (Number(currentCumulative) / 1e7).toFixed(7)
        return { closeTxHash, totalPaid, vouchersIssued }
      },
    }

    return handle
  }
}
