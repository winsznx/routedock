/**
 * Tests for #396 — nulth vault pay() must reserve against the local spendCap.
 *
 * RouteDockClient.pay() used to hand off to _payWithNulthVault() *before*
 * _checkAndReserveSpend() ran, so a client configured with both `spendCap` and
 * `vault: { mode: 'nulth' }` could make x402 payments with no local limit, and
 * vault spend never counted toward the cap for later payments.
 *
 * These drive the real RouteDockClient.pay() against a signed manifest from a
 * local server, stubbing only the trustline preflight and _payWithNulthVault so
 * the focus is the reserve / commit / rollback wiring around the vault path.
 *
 * Run with: pnpm --filter @routedock/routedock test
 */
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import assert from 'node:assert/strict'
import test from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import { RouteDockClient, type VaultConfig, type SpendCap } from '../RouteDockClient.js'
import { RouteDockPolicyRejectError } from '../../errors.js'
import type { PaymentResult } from '../../types.js'
import { signManifest } from '../../manifest/sign.js'
import { InMemorySpendStore } from '../../store/SpendStore.js'

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
        close: () => new Promise<void>((res) => server.close(() => res())),
      })
    })
  })
}

const PAYEE_KEYPAIR = Keypair.random()

const MANIFEST = signManifest(
  {
    routedock: '1.0',
    name: 'Nulth Cap Test Provider',
    description: 'x402 provider exercised by #396 nulth spend-cap tests',
    modes: ['x402'],
    network: 'testnet',
    asset: 'USDC',
    asset_contract: 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
    payee: PAYEE_KEYPAIR.publicKey(),
    pricing: {
      x402: {
        amount: '0.50',
        per: 'request',
        facilitator: 'https://channels.openzeppelin.com/x402/testnet',
      },
    },
    endpoints: { price: { method: 'GET', path: '/price' } },
    tags: ['test'],
  },
  PAYEE_KEYPAIR.secret(),
)

function manifestServer() {
  return startTestServer((req, res) => {
    if (req.url === '/.well-known/routedock.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(MANIFEST))
    } else {
      res.writeHead(404)
      res.end()
    }
  })
}

const VAULT: VaultConfig = {
  mode: 'nulth',
  nulthAccount: 'CAX5IDLC2XHGQSEA2YN3LPLZ7EXLMRXYX3HFJGKFXS6B7OQXBKWO44LT',
  witnessSecret: 'test-witness-secret',
  allowedPayees: [PAYEE_KEYPAIR.publicKey()],
  dailyCapUsdc: '100',
}

const OK_RESULT: PaymentResult = {
  data: { ok: true },
  txHash: 'vaulttx',
  mode: 'x402',
  amount: '0.50',
  timestamp: 0,
}

/**
 * Build a client whose trustline preflight and vault payment are stubbed, so the
 * test exercises only pay()'s reserve/commit/rollback wiring around the vault.
 */
function buildClient(opts: {
  spendCap?: SpendCap
  store?: InMemorySpendStore
  vaultImpl: () => Promise<PaymentResult>
}) {
  const client = new RouteDockClient({
    wallet: Keypair.random(),
    network: 'testnet',
    vault: VAULT,
    ...(opts.spendCap && { spendCap: opts.spendCap }),
    ...(opts.store && { spendStore: opts.store }),
  })
  // Skip the Horizon trustline round-trip (irrelevant to the cap wiring).
  ;(client as unknown as { _checkTrustline: () => Promise<void> })._checkTrustline = async () => {}
  let vaultCalls = 0
  ;(client as unknown as { _payWithNulthVault: () => Promise<PaymentResult> })._payWithNulthVault =
    async () => {
      vaultCalls++
      return opts.vaultImpl()
    }
  return { client, getVaultCalls: () => vaultCalls }
}

// ── 1. Over-cap nulth payment is rejected before the vault is touched ──────────
test('#396 — nulth pay over the daily cap throws local_daily_cap_exceeded, vault never attempted', async () => {
  const server = await manifestServer()
  try {
    const { client, getVaultCalls } = buildClient({
      spendCap: { daily: '0.10', asset: 'USDC' },
      vaultImpl: async () => OK_RESULT,
    })
    await assert.rejects(
      () => client.pay(`${server.url}/price`),
      (err: unknown) => {
        assert.ok(err instanceof RouteDockPolicyRejectError, `expected policy reject, got ${String(err)}`)
        assert.equal((err as RouteDockPolicyRejectError).reason, 'local_daily_cap_exceeded')
        return true
      },
    )
    assert.equal(getVaultCalls(), 0, 'vault payment must not be attempted once the cap rejects')
  } finally {
    await server.close()
  }
})

// ── 2. endpointCaps apply to nulth payments the same as non-vault x402 ─────────
test('#396 — endpointCaps is enforced for nulth payments', async () => {
  const server = await manifestServer()
  try {
    const origin = new URL(server.url).origin
    const { client, getVaultCalls } = buildClient({
      spendCap: { daily: '100', asset: 'USDC', endpointCaps: { [origin]: '0.10' } },
      vaultImpl: async () => OK_RESULT,
    })
    await assert.rejects(
      () => client.pay(`${server.url}/price`),
      (err: unknown) => {
        assert.ok(err instanceof RouteDockPolicyRejectError)
        assert.equal((err as RouteDockPolicyRejectError).reason, 'local_endpoint_cap_exceeded')
        return true
      },
    )
    assert.equal(getVaultCalls(), 0)
  } finally {
    await server.close()
  }
})

// ── 3. A successful nulth payment is committed and reduces the remaining cap ───
test('#396 — successful nulth payment is committed; a later pay sees the reduced cap', async () => {
  const server = await manifestServer()
  const store = new InMemorySpendStore({ warn: false })
  try {
    const { client, getVaultCalls } = buildClient({
      spendCap: { daily: '0.60', asset: 'USDC' },
      store,
      vaultImpl: async () => OK_RESULT,
    })
    const result = await client.pay(`${server.url}/price`)
    assert.deepEqual(result, OK_RESULT)
    assert.equal(getVaultCalls(), 1)

    const recorded = await store.read()
    assert.ok(recorded)
    assert.equal(recorded!.totalMicros, '5000000', '0.50 USDC recorded as 5,000,000 stroops')

    // Remaining cap is now 0.10 < 0.50, so a second vault pay must be rejected.
    await assert.rejects(
      () => client.pay(`${server.url}/price`),
      (err: unknown) => {
        assert.ok(err instanceof RouteDockPolicyRejectError)
        assert.equal((err as RouteDockPolicyRejectError).reason, 'local_daily_cap_exceeded')
        return true
      },
    )
    assert.equal(getVaultCalls(), 1, 'the rejected second pay must not reach the vault')
    const after = await store.read()
    assert.equal(after!.totalMicros, '5000000', 'rejected pay leaves the accumulator unchanged')
  } finally {
    await server.close()
  }
})

// ── 4. A failed nulth payment rolls back its reservation ──────────────────────
test('#396 — a failed nulth payment rolls back, leaving the spend total unchanged', async () => {
  const server = await manifestServer()
  const store = new InMemorySpendStore({ warn: false })
  try {
    const { client } = buildClient({
      spendCap: { daily: '1.00', asset: 'USDC' },
      store,
      // Mirrors _payWithNulthVault mapping a NulthPolicyError to RouteDockPolicyRejectError.
      vaultImpl: async () => {
        throw new RouteDockPolicyRejectError('daily_cap_exceeded')
      },
    })
    await assert.rejects(
      () => client.pay(`${server.url}/price`),
      (err: unknown) => {
        assert.ok(err instanceof RouteDockPolicyRejectError)
        assert.equal((err as RouteDockPolicyRejectError).reason, 'daily_cap_exceeded')
        return true
      },
    )
    const recorded = await store.read()
    // reserve wrote 5,000,000 then rollback subtracted it back to 0
    assert.equal(BigInt(recorded?.totalMicros ?? '0'), 0n, 'reservation rolled back to zero')
  } finally {
    await server.close()
  }
})

// ── 5. With no spendCap, the vault path still works (regression) ───────────────
test('#396 — with no spendCap, a nulth payment still succeeds', async () => {
  const server = await manifestServer()
  try {
    const { client, getVaultCalls } = buildClient({ vaultImpl: async () => OK_RESULT })
    const result = await client.pay(`${server.url}/price`)
    assert.deepEqual(result, OK_RESULT)
    assert.equal(getVaultCalls(), 1)
  } finally {
    await server.close()
  }
})
