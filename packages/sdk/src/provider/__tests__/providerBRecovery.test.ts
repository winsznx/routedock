import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import { reconcileAbandonedSessions } from '../SessionReconciler.js'

function makeSupabaseMock(rows: any[]) {
  const store = [...rows]
  return {
    from: (_table: string) => ({
      select: () => ({
        eq: (_field: string, val: string) => {
          const filtered = store.filter(r => r.status === val)
          return Promise.resolve({ data: filtered, error: null })
        },
      }),
      update: (data: any) => ({
        eq: (_field: string, val: string) => {
          const row = store.find(r => r.channel_id === val)
          if (row) Object.assign(row, data)
          return Promise.resolve({ error: null })
        },
      }),
    }),
  } as any
}

describe('Provider-B Session Recovery Pipeline', () => {
  const payeeKp = Keypair.random()
  const channelId = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'

  it('successfully recovers an orphaned closing session written by provider-b', async () => {
    // Simulate session row written by provider-b with stroop cumulative_amount, last_signature, and status: closing
    const providerBSessions = [
      {
        channel_id: channelId,
        payee: payeeKp.publicKey(),
        payer: 'GAGENT123',
        cumulative_amount: '50000', // 0.005 USDC in stroops (integer)
        status: 'closing',
        channel_contract: channelId,
        network: 'testnet',
        voucher_count: 5,
        last_signature: 'a'.repeat(128),
      },
    ]

    const mockChannelClose = async (args: any) => {
      assert.equal(args.channel, channelId)
      assert.equal(args.amount, 50000n)
      assert.equal(args.signature.toString('hex'), 'a'.repeat(128))
      return 'tx-hash-provider-b-settled'
    }

    const stats = await reconcileAbandonedSessions({
      supabase: makeSupabaseMock(providerBSessions),
      network: 'testnet',
      payeeSecretKey: payeeKp.secret(),
      channelClose: mockChannelClose as any,
    })

    assert.equal(stats.orphanedCount, 1)
    assert.equal(stats.recoveredCount, 1)
    assert.equal(stats.failedCount, 0)
    assert.equal(providerBSessions[0]!.status, 'settled')
    assert.equal(providerBSessions[0]!.settlement_tx_hash, 'tx-hash-provider-b-settled')
  })

  it('recovers legacy decimal cumulative_amount rows gracefully', async () => {
    const legacyDecimalSession = [
      {
        channel_id: channelId,
        payee: payeeKp.publicKey(),
        payer: 'GAGENT123',
        cumulative_amount: '0.005', // legacy decimal format
        status: 'closing',
        channel_contract: channelId,
        network: 'testnet',
        voucher_count: 5,
        last_signature: 'b'.repeat(128),
      },
    ]

    const mockChannelClose = async (args: any) => {
      assert.equal(args.amount, 50000n)
      return 'tx-hash-legacy-settled'
    }

    const stats = await reconcileAbandonedSessions({
      supabase: makeSupabaseMock(legacyDecimalSession),
      network: 'testnet',
      payeeSecretKey: payeeKp.secret(),
      channelClose: mockChannelClose as any,
    })

    assert.equal(stats.recoveredCount, 1)
    assert.equal(legacyDecimalSession[0]!.status, 'settled')
  })
})
