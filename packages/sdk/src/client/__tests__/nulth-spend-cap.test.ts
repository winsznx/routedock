/**
 * Issue #396: the nulth vault `pay()` path must run through the local spend
 * reservation (daily cap + endpoint caps), commit on success, and roll back on
 * failure — exactly like the non-vault x402 path.
 *
 * `prepareNulthSigner` is mocked so no proof is built and no RPC is hit, and
 * the x402 sub-client is replaced with a stub, so these tests exercise only the
 * client's spend accounting.
 *
 * Run with: pnpm --filter @routedock/routedock test
 */

import assert from 'node:assert/strict'
import { before, describe, it, mock } from 'node:test'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Keypair } from '@stellar/stellar-sdk'
import { InMemorySpendStore } from '../../store/SpendStore.js'
import { RouteDockPolicyRejectError, RouteDockManifestError } from '../../errors.js'
import { signManifest } from '../../manifest/sign.js'
import type { RouteDockManifest, PaymentResult } from '../../types.js'

const PAYEE_KEYPAIR = Keypair.random()
const NULTH = 'CAX5IDLC2XHGQSEA2YN3LPLZ7EXLMRXYX3HFJGKFXS6B7OQXBKWO44LT'

/** Stand-in for the real class RouteDockClient maps from. */
class FakeNulthPolicyError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'NulthPolicyError'
    this.code = code
  }
}

let prepareCalls = 0
let prepareImpl: () => Promise<{ signer: unknown; config: unknown }> = async () => ({
  signer: { kind: 'fake-nulth-signer' },
  config: {},
})

mock.module('../NulthVault.js', {
  namedExports: {
    NulthPolicyError: FakeNulthPolicyError,
    prepareNulthSigner: async () => {
      prepareCalls++
      return prepareImpl()
    },
  },
})

const { RouteDockClient } = await import('../RouteDockClient.js')

// ── Helpers ───────────────────────────────────────────────────────────────────

function startTestServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      })
    })
  })
}

function makeManifest(modes: Array<'x402' | 'mpp-charge'> = ['x402']): RouteDockManifest {
  const pricing: RouteDockManifest['pricing'] = {}
  if (modes.includes('x402')) {
    pricing.x402 = {
      amount: '0.001',
      per: 'request',
      facilitator: 'https://channels.openzeppelin.com/x402/testnet',
    }
  }
  if (modes.includes('mpp-charge')) {
    pricing['mpp-charge'] = { amount: '0.001', per: 'request' }
  }

  return signManifest(
    {
      routedock: '1.0',
      name: 'Nulth Spend Cap Test',
      description: 'Nulth vault spend cap tests',
      modes,
      network: 'testnet',
      asset: 'USDC',
      asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
      payee: PAYEE_KEYPAIR.publicKey(),
      pricing,
      endpoints: { test: { method: 'GET', path: '/test' } },
      tags: ['test'],
    },
    PAYEE_KEYPAIR.secret(),
  )
}

function makeManifestHandler(manifest: RouteDockManifest) {
  return (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === '/.well-known/routedock.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(manifest))
    } else {
      res.writeHead(404)
      res.end()
    }
  }
}

function stubTrustlineCache(client: InstanceType<typeof RouteDockClient>): void {
  const keypair = (client as any).keypair as Keypair
  const network = (client as any).network as string
  ;(RouteDockClient as any)._trustlineCache.set(`${network}:${keypair.publicKey()}:USDC`, {
    exists: true,
    expiresAt: Date.now() + 300_000,
  })
}

function fakeResult(mode: string, amount: string): PaymentResult {
  return {
    data: { ok: true },
    txHash: 'deadbeef',
    mode: mode as any,
    amount,
    timestamp: Date.now(),
  }
}

let x402PayCalls = 0
function installFakeX402(client: InstanceType<typeof RouteDockClient>): void {
  const pay = async () => {
    x402PayCalls++
    return fakeResult('x402', '0.001')
  }
  ;(client as any).x402 = {
    pay,
    withSigner: () => ({ pay }),
  }
}

function makeClient(opts: {
  spendCap: { daily: string; endpointCaps?: Record<string, string> }
  modes?: Array<'x402' | 'mpp-charge'>
}): InstanceType<typeof RouteDockClient> {
  return new RouteDockClient({
    wallet: Keypair.random(),
    network: 'testnet',
    spendCap: { asset: 'USDC', ...opts.spendCap },
    spendStore: new InMemorySpendStore({ warn: false }),
    vault: {
      mode: 'nulth',
      nulthAccount: NULTH,
      witnessSecret: 'witness-secret',
      allowedPayees: [PAYEE_KEYPAIR.publicKey()],
      dailyCapUsdc: '1.00',
    },
  })
}

before(() => {
  prepareCalls = 0
  x402PayCalls = 0
  prepareImpl = async () => ({ signer: { kind: 'fake-nulth-signer' }, config: {} })
})

// ── 1. Daily cap blocks the vault payment before it is attempted ──────────────

describe('RouteDockClient — nulth vault spend cap (#396)', () => {
  it('rejects an over-cap vault payment without attempting it', async () => {
    const server = await startTestServer(makeManifestHandler(makeManifest()))
    try {
      const client = makeClient({ spendCap: { daily: '0.0005' } })
      stubTrustlineCache(client)
      installFakeX402(client)
      prepareCalls = 0
      x402PayCalls = 0

      let caught: unknown
      try {
        await client.pay(`${server.url}/test`)
      } catch (err) {
        caught = err
      }

      assert.ok(caught instanceof RouteDockPolicyRejectError)
      assert.equal((caught as RouteDockPolicyRejectError).reason, 'local_daily_cap_exceeded')
      assert.equal(prepareCalls, 0, 'the vault signer must not be prepared when over cap')
      assert.equal(x402PayCalls, 0, 'no x402 payment may be attempted when over cap')
    } finally {
      await server.close()
    }
  })

  // ── 2. Endpoint caps apply to vault payments ────────────────────────────────

  it('enforces endpoint caps for vault payments', async () => {
    const server = await startTestServer(makeManifestHandler(makeManifest()))
    try {
      const client = makeClient({
        spendCap: { daily: '1.00', endpointCaps: { [server.url]: '0.0005' } },
      })
      stubTrustlineCache(client)
      installFakeX402(client)
      prepareCalls = 0
      x402PayCalls = 0

      let caught: unknown
      try {
        await client.pay(`${server.url}/test`)
      } catch (err) {
        caught = err
      }

      assert.ok(caught instanceof RouteDockPolicyRejectError)
      assert.equal((caught as RouteDockPolicyRejectError).reason, 'local_endpoint_cap_exceeded')
      assert.equal(prepareCalls, 0)
      assert.equal(x402PayCalls, 0)
    } finally {
      await server.close()
    }
  })

  // ── 3. A successful vault payment is committed to the accumulator ───────────

  it('records vault spend so it counts against a later non-vault payment', async () => {
    const server = await startTestServer(makeManifestHandler(makeManifest()))
    try {
      const store = new InMemorySpendStore({ warn: false })
      const client = new RouteDockClient({
        wallet: Keypair.random(),
        network: 'testnet',
        spendCap: { daily: '0.0015', asset: 'USDC' },
        spendStore: store,
        vault: {
          mode: 'nulth',
          nulthAccount: NULTH,
          witnessSecret: 'witness-secret',
          allowedPayees: [PAYEE_KEYPAIR.publicKey()],
          dailyCapUsdc: '1.00',
        },
      })
      stubTrustlineCache(client)
      installFakeX402(client)
      prepareCalls = 0
      x402PayCalls = 0

      const first = await client.pay(`${server.url}/test`)
      assert.equal(first.amount, '0.001')
      assert.equal(prepareCalls, 1, 'the vault path was actually taken')

      const afterVault = await store.read()
      assert.ok(afterVault)
      assert.equal(afterVault.totalMicros, '10000', 'vault spend must be recorded')

      // Switch to the non-vault path: the remaining cap is 0.0005, so another
      // 0.001 payment must be refused. This fails if vault spend was never
      // committed to the shared accumulator.
      ;(client as any).vault = undefined
      let caught: unknown
      try {
        await client.pay(`${server.url}/test`)
      } catch (err) {
        caught = err
      }
      assert.ok(caught instanceof RouteDockPolicyRejectError)
      assert.equal((caught as RouteDockPolicyRejectError).reason, 'local_daily_cap_exceeded')
    } finally {
      await server.close()
    }
  })

  // ── 4. A failed vault payment rolls its reservation back ────────────────────

  it('rolls back the reservation when NulthPolicyError maps to a policy reject', async () => {
    const server = await startTestServer(makeManifestHandler(makeManifest()))
    try {
      const store = new InMemorySpendStore({ warn: false })
      const client = new RouteDockClient({
        wallet: Keypair.random(),
        network: 'testnet',
        spendCap: { daily: '0.002', asset: 'USDC' },
        spendStore: store,
        vault: {
          mode: 'nulth',
          nulthAccount: NULTH,
          witnessSecret: 'witness-secret',
          allowedPayees: [PAYEE_KEYPAIR.publicKey()],
          dailyCapUsdc: '1.00',
        },
      })
      stubTrustlineCache(client)
      installFakeX402(client)
      prepareCalls = 0
      x402PayCalls = 0

      prepareImpl = async () => {
        throw new FakeNulthPolicyError('daily_cap_exceeded', 'Nulth daily cap exceeded')
      }

      let caught: unknown
      try {
        await client.pay(`${server.url}/test`)
      } catch (err) {
        caught = err
      }

      assert.ok(caught instanceof RouteDockPolicyRejectError)
      assert.equal((caught as RouteDockPolicyRejectError).reason, 'daily_cap_exceeded')

      const state = await store.read()
      assert.ok(state)
      assert.equal(state.totalMicros, '0', 'a failed vault payment must not consume budget')

      // The budget is intact, so a subsequent attempt can still reserve.
      prepareImpl = async () => ({ signer: { kind: 'fake-nulth-signer' }, config: {} })
      await client.pay(`${server.url}/test`)
      const after = await store.read()
      assert.ok(after)
      assert.equal(after.totalMicros, '10000')
    } finally {
      await server.close()
    }
  })

  // ── 5. Vault mode/prover validation errors also release the reservation ─────

  it('rolls back when the vault path rejects the payment mode', async () => {
    const server = await startTestServer(
      makeManifestHandler(makeManifest(['x402', 'mpp-charge'])),
    )
    try {
      const store = new InMemorySpendStore({ warn: false })
      const client = new RouteDockClient({
        wallet: Keypair.random(),
        network: 'testnet',
        spendCap: { daily: '0.002', asset: 'USDC' },
        spendStore: store,
        vault: {
          mode: 'nulth',
          nulthAccount: NULTH,
          witnessSecret: 'witness-secret',
          allowedPayees: [PAYEE_KEYPAIR.publicKey()],
          dailyCapUsdc: '1.00',
        },
      })
      stubTrustlineCache(client)
      installFakeX402(client)

      let caught: unknown
      try {
        await client.pay(`${server.url}/test`, { forceMode: 'mpp-charge' })
      } catch (err) {
        caught = err
      }

      assert.ok(caught instanceof RouteDockManifestError)
      const state = await store.read()
      assert.ok(state)
      assert.equal(state.totalMicros, '0', 'validation failure must release the reservation')
    } finally {
      await server.close()
    }
  })
})
