import assert from 'node:assert/strict'
import { mock, describe, it } from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const repoRoot = path.resolve(fileURLToPath(new URL('../../../../', import.meta.url)))
const resolveFromSdk = (specifier: string): string => {
  const parts = specifier.split('/')
  const pkgName = parts.slice(0, parts[0]!.startsWith('@') ? 2 : 1).join('/')
  const subpath = parts.slice(parts[0]!.startsWith('@') ? 2 : 1).join('/')
  const pkgPath = path.join(repoRoot, 'packages', 'sdk', 'node_modules', pkgName, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
    exports: Record<
      string,
      { import?: { default?: string } | string; default?: string } | string
    >
  }
  const exportKey = subpath ? `./${subpath}` : '.'
  const entry = pkg.exports[exportKey]
  const target =
    typeof entry === 'string'
      ? entry
      : typeof entry?.import === 'string'
        ? entry.import
        : entry?.import?.default ?? entry?.default
  if (!target) throw new Error(`No ESM export for ${specifier}`)
  return pathToFileURL(path.join(path.dirname(pkgPath), target)).href
}

const TEST_PAYEE_SECRET = 'SBB3ER7UC7MYPQYHLNTX4QINRTV4WPFE2T644J64XTAUNKJMOGOVJGLL'
const TEST_PAYEE_ADDRESS = 'GBRLCID5A2S6HUC4D4DSWPRWNO75CLNHS2SIPS2BPCCP55Z5N7Z36DJD'
const TESTNET_USDC_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'

let settleCalls = 0

mock.module(resolveFromSdk('@x402/stellar/exact/facilitator'), {
  namedExports: {
    ExactStellarScheme: class {
      async verify() {
        return { isValid: true }
      }
      async settle() {
        settleCalls++
        return { success: true, transaction: `PROVIDER_A_TX_${settleCalls}` }
      }
    },
  },
})

mock.module(resolveFromSdk('@x402/stellar/exact/server'), {
  namedExports: { ExactStellarScheme: class {} },
})

mock.module(resolveFromSdk('@x402/core/server'), {
  namedExports: {
    HTTPFacilitatorClient: class {},
    x402ResourceServer: class {
      register() {}
      async createPaymentRequiredResponse() {
        return { x402Version: 2, accepts: [] }
      }
      async settlePayment() {
        settleCalls++
        return { success: true, transaction: `PROVIDER_A_TX_${settleCalls}` }
      }
    },
  },
})

mock.module(resolveFromSdk('@x402/core/http'), {
  namedExports: {
    decodePaymentSignatureHeader: () => ({
      authorization: { credentials: [{ publicKey: TEST_PAYEE_ADDRESS }] },
    }),
    encodePaymentRequiredHeader: (value: unknown) => `requirements:${JSON.stringify(value)}`,
    encodePaymentResponseHeader: (value: unknown) => `response:${JSON.stringify(value)}`,
  },
})

mock.module(resolveFromSdk('@x402/stellar'), {
  namedExports: { createEd25519Signer: () => ({}) },
})

mock.module(resolveFromSdk('@stellar/mpp/charge/server'), {
  namedExports: { stellar: () => ({}) },
})

mock.module(resolveFromSdk('@stellar/mpp/channel/server'), {
  namedExports: {
    Store: { memory: () => ({}) },
    stellar: () => [],
    close: async () => 'CLOSE_TX',
  },
})

mock.module(resolveFromSdk('mppx/server'), {
  namedExports: {
    Mppx: { create: () => ({ channel: async () => ({ status: 200 }) }) },
  },
})

const insertPromises: Promise<{ error: null }>[] = []
let releaseInsert: (() => void) | null = null
let insertCalls = 0

mock.module('@supabase/supabase-js', {
  namedExports: {
    createClient: () => ({
      from(table: string) {
        if (table === 'tx_log') {
          return {
            insert() {
              insertCalls++
              const promise = new Promise<{ error: null }>((resolve) => {
                releaseInsert = () => resolve({ error: null })
              })
              insertPromises.push(promise)
              return promise
            },
          }
        }
        return {
          select() {
            return {
              eq() {
                return {
                  maybeSingle: async () => ({ data: null, error: null }),
                }
              },
            }
          },
          upsert: async () => ({ error: null }),
        }
      },
      rpc: async () => ({ data: null, error: null }),
    }),
  },
})

const { default: worker } = await import('../worker.js')

function fakeCtx() {
  const promises: Promise<unknown>[] = []
  return {
    promises,
    waitUntil(promise: Promise<unknown>) { promises.push(promise) },
    passThroughOnException() {},
  }
}

describe('provider-a worker callback lifetime', () => {
  it('registers the tx_log insert with the current request ctx.waitUntil', async () => {
    const env = {
      STELLAR_NETWORK: 'testnet',
      STELLAR_PAYEE_SECRET: TEST_PAYEE_SECRET,
      STELLAR_PAYEE_ADDRESS: TEST_PAYEE_ADDRESS,
      USDC_ASSET_CONTRACT: TESTNET_USDC_CONTRACT,
      PUBLIC_BASE_URL: 'https://api-a.routedock.xyz',
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_KEY: 'service-key',
    }

    const ctx1 = fakeCtx()
    const first = await worker.fetch(
      new Request('http://localhost/price', { headers: { 'payment-signature': 'first-payment' } }),
      env,
      ctx1 as never,
    )
    assert.equal(first.status, 200)
    assert.equal(ctx1.promises.length, 2)
    assert.equal(insertCalls, 1)
    releaseInsert?.()
    await Promise.all(ctx1.promises)

    const ctx2 = fakeCtx()
    const second = await worker.fetch(
      new Request('http://localhost/price', { headers: { 'payment-signature': 'second-payment' } }),
      env,
      ctx2 as never,
    )
    assert.equal(second.status, 200)
    assert.equal(insertCalls, 2)
    assert.equal(ctx2.promises.length, 1)
    assert.notEqual(ctx2.promises[0], ctx1.promises[0])

    let finished = false
    void ctx2.promises[0]!.then(() => { finished = true })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(finished, false, 'tx_log insert must stay attached to the pending request')

    releaseInsert?.()
    await ctx2.promises[0]
    assert.equal(finished, true)
  })
})
