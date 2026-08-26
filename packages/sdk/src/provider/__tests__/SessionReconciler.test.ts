import assert from 'node:assert/strict'
import test from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { decimalToStroops, reconcileAbandonedSessions } from '../SessionReconciler.js'

test('decimalToStroops converts decimal strings to stroops correctly', () => {
  assert.equal(decimalToStroops('5'), 50000000n)
  assert.equal(decimalToStroops('5.0'), 50000000n)
  assert.equal(decimalToStroops('0.0010000'), 10000n)
  assert.equal(decimalToStroops('0.001'), 10000n)
  assert.equal(decimalToStroops('1.5'), 15000000n)
  assert.equal(decimalToStroops('10000'), 100000000000n)
  assert.equal(decimalToStroops('0.0000001'), 1n)
  assert.throws(() => decimalToStroops('0.00000001'), /exceeds 7 decimals/)
})

test('reconcileAbandonedSessions processes "0.0010000" decimal string without throwing SyntaxError', async () => {
  const payeeKeypair = Keypair.random()

  // Mock Supabase client
  const mockSupabase = {
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_field: string, _val: string) => ({
          is: (_field2: string, _val2: any) => ({
            limit: async (_limit: number) => ({
              data: [
                {
                  channel_id: 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH',
                  cumulative_amount: '0.0010000',
                  last_signature: '00'.repeat(64),
                  settlement_tx_hash: null,
                },
              ],
              error: null,
            }),
          }),
        }),
      }),
      update: (_data: any) => ({
        eq: (_field: string, _val: string) => Promise.resolve({ error: null }),
      }),
    }),
  } as unknown as SupabaseClient

  // Call reconcile; it will try to broadcast channelClose which fails in mock environment,
  // but it should NOT throw a SyntaxError on BigInt('0.0010000')!
  const stats = await reconcileAbandonedSessions({
    supabase: mockSupabase,
    network: 'testnet',
    payeeSecretKey: payeeKeypair.secret(),
  })

  assert.equal(stats.orphanedCount, 1)
  // Check that the error was not SyntaxError: Cannot convert 0.0010000 to a BigInt
  if (stats.errors.length > 0) {
    const errReason = stats.errors[0]?.reason ?? ''
    assert.ok(!errReason.includes('SyntaxError'))
    assert.ok(!errReason.includes('Cannot convert'))
  }
})

test('reconcileAbandonedSessions records structured close failures readably', async () => {
  const payeeKeypair = Keypair.random()
  const mockSupabase = {
    from: () => ({
      select: () => ({
        eq: () => ({
          is: () => ({
            limit: async () => ({
              data: [{
                channel_id: 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH',
                cumulative_amount: '0.0010000',
                last_signature: '00'.repeat(64),
                settlement_tx_hash: null,
              }],
              error: null,
            }),
          }),
        }),
      }),
    }),
  } as any

  const stats = await reconcileAbandonedSessions({
    supabase: mockSupabase,
    network: 'testnet',
    payeeSecretKey: payeeKeypair.secret(),
    channelClose: async () => Promise.reject({ code: 'scecInvalidAction', status: 'FAILED' }),
  })

  assert.equal(stats.errors[0]?.reason, '{"code":"scecInvalidAction","status":"FAILED"}')
})
