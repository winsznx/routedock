import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import { reconcileAbandonedSessions } from '../SessionReconciler.js'

function makeSupabaseMock(rows: any[]) {
  const store = [...rows]
  return {
    from: (_table: string) => ({
      // Chainable so it mirrors the reconciler's real query:
      // .select(...).eq('status','closing').is('settlement_tx_hash', null).limit(100)
      select: (_cols?: string) => {
        const filters: Array<(r: any) => boolean> = []
        let cap = Infinity
        const query = {
          eq: (field: string, val: unknown) => {
            filters.push(r => r[field] === val)
            return query
          },
          is: (field: string, val: unknown) => {
            filters.push(r => (r[field] ?? null) === val)
            return query
          },
          limit: (n: number) => {
            cap = n
            return query
          },
          then: (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
            Promise.resolve({
              data: store.filter(r => filters.every(f => f(r))).slice(0, cap),
              error: null,
            }).then(onOk, onErr),
        }
        return query
      },
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
    const providerBSessions: any[] = [
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
    assert.equal(providerBSessions[0]!.status, 'closed')
    assert.equal(providerBSessions[0]!.settlement_tx_hash, 'tx-hash-provider-b-settled')
  })

  it('recovers legacy decimal cumulative_amount rows gracefully', async () => {
    const legacyDecimalSession: any[] = [
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
    assert.equal(legacyDecimalSession[0]!.status, 'closed')
  })
})
