import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import type { SupabaseClient } from '@supabase/supabase-js'
import { registerProvider } from '../registerProvider.js'
import { manifestDigest, signManifest } from '../../manifest/sign.js'
import { bytesToHex } from '../../internal/encoding.js'
import type { RouteDockManifest } from '../../types.js'
import { RouteDockSignatureError } from '../../errors.js'

describe('registerProvider', () => {
  const keypair = Keypair.random()
  const payee = keypair.publicKey()
  const secret = keypair.secret()

  const rawManifest: RouteDockManifest = {
    routedock: '1.0',
    name: 'Test DEX Provider',
    description: 'Test provider description',
    modes: ['x402', 'mpp-charge'],
    network: 'testnet',
    asset: 'USDC',
    asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    payee,
    pricing: {
      x402: { amount: '0.001', per: 'request' },
      'mpp-charge': { amount: '0.0008', per: 'request' },
    },
    endpoints: { price: { method: 'GET', path: '/price' } },
    tags: ['price', 'dex', 'stellar'],
    categories: ['data/price'],
  }

  it('rejects an unsigned manifest with RouteDockSignatureError', async () => {
    const mockSupabase = {} as SupabaseClient
    await assert.rejects(
      () => registerProvider({ supabase: mockSupabase, manifest: rawManifest, baseUrl: 'https://api.test' }),
      RouteDockSignatureError,
    )
  })

  it('rejects a manifest with an invalid signature', async () => {
    const mockSupabase = {} as SupabaseClient
    const tampered = {
      ...rawManifest,
      signature_version: '2' as const,
      signature: Buffer.from('invalid-signature-bytes-not-real').toString('base64'),
    }

    await assert.rejects(
      () => registerProvider({ supabase: mockSupabase, manifest: tampered, baseUrl: 'https://api.test' }),
      RouteDockSignatureError,
    )
  })

  type Call = { op: 'select' | 'upsert' | 'update'; payload?: Record<string, unknown>; options?: Record<string, unknown> }

  function recordingSupabase(existing: { manifest_digest: string | null; last_seen_at: string } | null) {
    const calls: Call[] = []
    const client = {
      from(table: string) {
        assert.equal(table, 'providers')
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => {
                calls.push({ op: 'select' })
                return { data: existing, error: null }
              },
            }),
          }),
          upsert: async (payload: Record<string, unknown>, options: Record<string, unknown>) => {
            calls.push({ op: 'upsert', payload, options })
            return { error: null }
          },
          update: (payload: Record<string, unknown>) => ({
            eq: async () => {
              calls.push({ op: 'update', payload })
              return { error: null }
            },
          }),
        }
      },
    } as unknown as SupabaseClient
    return { client, calls, writes: () => calls.filter((c) => c.op !== 'select') }
  }

  it('upserts a valid signed manifest without a verified flag', async () => {
    const signed = signManifest(rawManifest, secret)
    const { client, calls } = recordingSupabase(null)

    await registerProvider({ supabase: client, manifest: signed, baseUrl: 'https://api.test/' })

    const upsert = calls.find((c) => c.op === 'upsert')
    assert.ok(upsert?.payload)
    const payload = upsert.payload
    assert.equal(payload['name'], 'Test DEX Provider')
    assert.equal(payload['base_url'], 'https://api.test')
    assert.equal(payload['payee'], payee)
    assert.deepEqual(payload['tags'], ['price', 'dex', 'stellar'])
    assert.equal(payload['manifest_digest'], bytesToHex(manifestDigest(signed)))
    assert.ok(typeof payload['last_seen_at'] === 'string')
    assert.equal('verified' in payload, false)
    assert.equal('registered_at' in payload, false)
    assert.equal('first_registered_at' in payload, false)
    assert.deepEqual(upsert.options, { onConflict: 'base_url' })
  })

  it('never sends verified, even when a caller passes verified: true', async () => {
    const signed = signManifest(rawManifest, secret)
    const warnings: string[] = []
    const logger = (level: string, message: string) => { if (level === 'warn') warnings.push(message) }
    const options = recordingSupabase(null)
    await registerProvider({ supabase: options.client, manifest: signed, baseUrl: 'https://api.test', verified: true, logger })
    const positional = recordingSupabase(null)
    await registerProvider(positional.client, signed, 'https://api.test', true)

    for (const { calls } of [options, positional]) {
      const upsert = calls.find((c) => c.op === 'upsert')
      assert.ok(upsert?.payload)
      assert.equal('verified' in upsert.payload, false)
    }
    assert.ok(warnings.length >= 1, 'deprecated verified option logs a warning')
  })

  it('writes at most once when the same signed manifest is registered twice', async () => {
    const signed = signManifest(rawManifest, secret)
    const digest = bytesToHex(manifestDigest(signed))
    let stored: { manifest_digest: string | null; last_seen_at: string } | null = null
    let writes = 0

    const client = {
      from() {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: stored, error: null }) }) }),
          upsert: async (payload: Record<string, unknown>) => {
            writes += 1
            stored = { manifest_digest: payload['manifest_digest'] as string, last_seen_at: payload['last_seen_at'] as string }
            return { error: null }
          },
          update: () => ({ eq: async () => { writes += 1; return { error: null } } }),
        }
      },
    } as unknown as SupabaseClient

    await registerProvider({ supabase: client, manifest: signed, baseUrl: 'https://api.test' })
    await registerProvider({ supabase: client, manifest: signed, baseUrl: 'https://api.test' })

    assert.equal(writes, 1)
    assert.equal(stored!.manifest_digest, digest)
  })

  it('only refreshes last_seen_at once the touch interval has elapsed', async () => {
    const signed = signManifest(rawManifest, secret)
    const digest = bytesToHex(manifestDigest(signed))

    const fresh = recordingSupabase({ manifest_digest: digest, last_seen_at: new Date().toISOString() })
    await registerProvider({ supabase: fresh.client, manifest: signed, baseUrl: 'https://api.test' })
    assert.equal(fresh.writes().length, 0)

    const stale = recordingSupabase({ manifest_digest: digest, last_seen_at: '2020-01-01T00:00:00.000Z' })
    await registerProvider({ supabase: stale.client, manifest: signed, baseUrl: 'https://api.test' })
    const [touch, ...rest] = stale.writes()
    assert.equal(rest.length, 0)
    assert.equal(touch?.op, 'update')
    assert.deepEqual(Object.keys(touch!.payload!), ['last_seen_at'])

    const custom = recordingSupabase({ manifest_digest: digest, last_seen_at: new Date(Date.now() - 5_000).toISOString() })
    await registerProvider({ supabase: custom.client, manifest: signed, baseUrl: 'https://api.test', touchIntervalMs: 1_000 })
    assert.equal(custom.writes().length, 1)
  })

  it('rewrites the row when the stored digest differs', async () => {
    const signed = signManifest(rawManifest, secret)
    const changed = recordingSupabase({ manifest_digest: 'old-digest', last_seen_at: new Date().toISOString() })
    await registerProvider({ supabase: changed.client, manifest: signed, baseUrl: 'https://api.test' })
    assert.equal(changed.writes().map((c) => c.op).join(), 'upsert')
  })

  it('supports positional arguments overload', async () => {
    const signed = signManifest(rawManifest, secret)
    const { client, writes } = recordingSupabase(null)

    await registerProvider(client, signed, 'https://api.test')
    assert.equal(writes().length, 1)
  })
})
