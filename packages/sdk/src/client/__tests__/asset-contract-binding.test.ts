/**
 * Issue #711: bind the selected payment asset ticker to its derived Stellar
 * Asset Contract (SAC) before any trustline check, spend reservation, or fetch.
 *
 * Run with: pnpm --filter @routedock/routedock test
 */

import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, describe, it, mock } from 'node:test'
import { Asset, Horizon, Keypair, Networks } from '@stellar/stellar-sdk'
import { RouteDockClient } from '../RouteDockClient.js'
import { RouteDockPolicyRejectError, RouteDockTrustlineError } from '../../errors.js'
import { expectedAssetContract } from '../../internal/assetUtils.js'
import { USDC_ISSUERS } from '../../network.js'
import { signManifest } from '../../manifest/sign.js'
import { InMemorySpendStore } from '../../store/SpendStore.js'
import type { PaymentResult, RouteDockManifest } from '../../types.js'

const PAYEE = Keypair.random()
const USDC_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const XLM_CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
const CHANNEL_FACTORY = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'

interface TestServer {
  url: string
  paidRequests: number
  close: () => Promise<void>
}

function startManifestServer(manifest: RouteDockManifest): Promise<TestServer> {
  return new Promise((resolve) => {
    let paidRequests = 0
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url === '/.well-known/routedock.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(manifest))
        return
      }
      paidRequests++
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      resolve({
        url: `http://127.0.0.1:${port}`,
        get paidRequests() {
          return paidRequests
        },
        close: () => new Promise<void>((r) => server.close(() => r())),
      })
    })
  })
}

function makeSignedManifest(overrides: Partial<RouteDockManifest> = {}): RouteDockManifest {
  return signManifest(
    {
      routedock: '1.0',
      name: 'Asset Binding Test Provider',
      description: 'Provider for issue #711 SAC binding tests',
      modes: ['x402', 'mpp-charge', 'mpp-session'],
      network: 'testnet',
      asset: 'USDC',
      asset_contract: USDC_CONTRACT,
      payee: PAYEE.publicKey(),
      pricing: {
        x402: {
          amount: '1.00',
          per: 'request',
          facilitator: 'https://channels.openzeppelin.com/x402/testnet',
        },
        'mpp-charge': { amount: '1.00', per: 'request' },
        'mpp-session': {
          rate: '0.0001',
          per: 'voucher',
          channel_factory: CHANNEL_FACTORY,
          min_deposit: '0.10',
          refund_waiting_period_ledgers: 17280,
        },
      },
      endpoints: { test: { method: 'GET', path: '/test' } },
      tags: ['test'],
      ...overrides,
    },
    PAYEE.secret(),
  )
}

function fakePaymentResult(mode: 'x402' | 'mpp-charge', amount = '1.00'): PaymentResult {
  return {
    data: { ok: true },
    txHash: 'deadbeef',
    mode,
    amount,
    timestamp: Date.now(),
  }
}

describe('Issue #711 — asset ticker to asset_contract binding', () => {
  afterEach(() => {
    mock.restoreAll()
  })

  it('expectedAssetContract derives testnet USDC and XLM SAC addresses', () => {
    assert.equal(
      expectedAssetContract('USDC', USDC_ISSUERS.testnet, 'testnet'),
      USDC_CONTRACT,
    )
    assert.equal(
      expectedAssetContract('XLM', undefined, 'testnet'),
      XLM_CONTRACT,
    )
  })

  it('pay() against a signed manifest with asset="USDC" and XLM SAC as asset_contract rejects with asset_contract_mismatch before trustline, spend reserve, or paid fetch', async () => {
    const mislabeled = makeSignedManifest({
      asset: 'USDC',
      asset_contract: XLM_CONTRACT,
    })
    const server = await startManifestServer(mislabeled)
    try {
      const store = new InMemorySpendStore({ warn: false })
      let horizonCalls = 0
      mock.method(Horizon.Server.prototype, 'loadAccount', async () => {
        horizonCalls++
        return { balances: [] }
      })

      const realFetch = globalThis.fetch
      let paidUrlFetches = 0
      mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
        const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (!href.endsWith('/.well-known/routedock.json')) {
          paidUrlFetches++
        }
        return realFetch(input, init)
      })

      const client = new RouteDockClient({
        wallet: Keypair.random(),
        network: 'testnet',
        spendCap: { daily: '10.00', asset: 'USDC' },
        spendStore: store,
      })

      await assert.rejects(
        () => client.pay(`${server.url}/test`),
        (err: unknown) => {
          assert.ok(err instanceof RouteDockPolicyRejectError)
          assert.equal(err.reason, 'asset_contract_mismatch')
          return true
        },
      )

      assert.equal(horizonCalls, 0, 'must make no trustline call')
      assert.equal(await store.read(), null, 'must reserve no spend')
      assert.equal(paidUrlFetches, 0, 'must never call fetch on the paid URL')
      assert.equal(server.paidRequests, 0, 'server must receive zero paid endpoint requests')
    } finally {
      await server.close()
    }
  })

  it('openSession() against a signed manifest with asset="USDC" and XLM SAC as asset_contract rejects with asset_contract_mismatch before any voucher is signed', async () => {
    const mislabeled = makeSignedManifest({
      modes: ['mpp-session'],
      asset: 'USDC',
      asset_contract: XLM_CONTRACT,
    })
    const server = await startManifestServer(mislabeled)
    try {
      const store = new InMemorySpendStore({ warn: false })
      const realFetch = globalThis.fetch
      let sessionFetches = 0
      mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
        const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        if (!href.endsWith('/.well-known/routedock.json')) {
          sessionFetches++
        }
        return realFetch(input, init)
      })

      const client = new RouteDockClient({
        wallet: Keypair.random(),
        network: 'testnet',
        commitmentSecret: Keypair.random().secret(),
        spendCap: { daily: '10.00', asset: 'USDC' },
        spendStore: store,
      })

      await assert.rejects(
        () => client.openSession(`${server.url}/test`),
        (err: unknown) => {
          assert.ok(err instanceof RouteDockPolicyRejectError)
          assert.equal(err.reason, 'asset_contract_mismatch')
          return true
        },
      )

      assert.equal(sessionFetches, 0, 'must not open session or sign any voucher')
      assert.equal(await store.read(), null, 'must reserve no spend')
      assert.equal(server.paidRequests, 0)
    } finally {
      await server.close()
    }
  })

  it('estimateCost() and preflight() also reject a mislabeled asset_contract with asset_contract_mismatch', async () => {
    const mislabeled = makeSignedManifest({
      asset: 'USDC',
      asset_contract: XLM_CONTRACT,
    })
    const server = await startManifestServer(mislabeled)
    try {
      const client = new RouteDockClient({
        wallet: Keypair.random(),
        network: 'testnet',
      })

      await assert.rejects(
        () => client.estimateCost(`${server.url}/test`),
        (err: unknown) => err instanceof RouteDockPolicyRejectError && err.reason === 'asset_contract_mismatch',
      )
      await assert.rejects(
        () => client.preflight(`${server.url}/test`),
        (err: unknown) => err instanceof RouteDockPolicyRejectError && err.reason === 'asset_contract_mismatch',
      )
      await assert.rejects(
        () => client.preflight(mislabeled),
        (err: unknown) => err instanceof RouteDockPolicyRejectError && err.reason === 'asset_contract_mismatch',
      )
    } finally {
      await server.close()
    }
  })

  it('rejects an asset whose contract cannot be derived when spendCap is set, and proceeds with one warning when uncapped', async () => {
    const unknownIssuer = Keypair.random().publicKey()
    const unknownSac = new Asset('EURC', unknownIssuer).contractId(Networks.TESTNET)
    const unknownManifest = makeSignedManifest({
      modes: ['mpp-charge'],
      asset: 'EURC',
      asset_contract: unknownSac,
    })
    const server = await startManifestServer(unknownManifest)
    try {
      const store = new InMemorySpendStore({ warn: false })
      const cappedClient = new RouteDockClient({
        wallet: Keypair.random(),
        network: 'testnet',
        spendCap: { daily: '10.00', asset: 'USDC' },
        spendStore: store,
      })

      await assert.rejects(
        () => cappedClient.pay(`${server.url}/test`),
        (err: unknown) => {
          assert.ok(err instanceof RouteDockPolicyRejectError)
          assert.equal(err.reason, 'asset_contract_mismatch')
          return true
        },
      )
      assert.equal(await store.read(), null)

      const warnings: string[] = []
      const uncappedWallet = Keypair.random()
      mock.method(Horizon.Server.prototype, 'loadAccount', async () => ({
        balances: [
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'EURC',
            asset_issuer: unknownIssuer,
            balance: '100.0000000',
          },
        ],
      }))

      const uncappedClient = new RouteDockClient({
        wallet: uncappedWallet,
        network: 'testnet',
        logger: (level, message) => {
          if (level === 'warn') warnings.push(message)
        },
      })
      const internals = uncappedClient as unknown as {
        charge: { pay: () => Promise<PaymentResult> }
      }
      internals.charge.pay = async () => fakePaymentResult('mpp-charge', '1.00')

      const result = await uncappedClient.pay(`${server.url}/test`)
      assert.equal(result.amount, '1.00')
      assert.equal(warnings.length, 1, `expected exactly one warning, got ${warnings.length}`)
      assert.match(warnings[0]!, /EURC/)
    } finally {
      await server.close()
    }
  })

  it('binds a custom asset with asset_issuer to its derived SAC and checks trustline by code and issuer', async () => {
    const issuer = Keypair.random().publicKey()
    const wrongIssuer = Keypair.random().publicKey()
    const eurcSac = new Asset('EURC', issuer).contractId(Networks.TESTNET)
    const validCustomManifest = makeSignedManifest({
      modes: ['mpp-charge'],
      asset: 'EURC',
      asset_issuer: issuer,
      asset_contract: eurcSac,
    })

    mock.method(Horizon.Server.prototype, 'loadAccount', async () => ({
      balances: [
        {
          asset_type: 'credit_alphanum4',
          asset_code: 'EURC',
          asset_issuer: wrongIssuer,
          balance: '100.0000000',
        },
      ],
    }))

    const client = new RouteDockClient({
      wallet: Keypair.random(),
      network: 'testnet',
    })

    await assert.rejects(
      () => client.preflight(validCustomManifest),
      (err: unknown) => {
        assert.ok(err instanceof RouteDockTrustlineError)
        assert.equal(err.asset, 'EURC')
        assert.equal(err.issuer, issuer)
        return true
      },
    )

    // Trustline for wrongIssuer must NOT satisfy a manifest for issuer, even
    // after preflighting a manifest for wrongIssuer on the same client.
    const wrongIssuerManifest = makeSignedManifest({
      modes: ['mpp-charge'],
      asset: 'EURC',
      asset_issuer: wrongIssuer,
      asset_contract: new Asset('EURC', wrongIssuer).contractId(Networks.TESTNET),
    })
    const ok = await client.preflight(wrongIssuerManifest)
    assert.equal(ok.hasTrustline, true)

    await assert.rejects(
      () => client.preflight(validCustomManifest),
      (err: unknown) => err instanceof RouteDockTrustlineError && err.issuer === issuer,
    )
  })

  it('rejects a manifest that tries to spoof USDC with a custom asset_issuer and its SAC', async () => {
    const attackerIssuer = Keypair.random().publicKey()
    const attackerUsdcSac = new Asset('USDC', attackerIssuer).contractId(Networks.TESTNET)
    const spoofed = makeSignedManifest({
      asset: 'USDC',
      asset_issuer: attackerIssuer,
      asset_contract: attackerUsdcSac,
    })

    const client = new RouteDockClient({
      wallet: Keypair.random(),
      network: 'testnet',
      spendCap: { daily: '10.00', asset: 'USDC' },
    })

    await assert.rejects(
      () => client.preflight(spoofed),
      (err: unknown) => err instanceof RouteDockPolicyRejectError && err.reason === 'asset_contract_mismatch',
    )
  })
})
