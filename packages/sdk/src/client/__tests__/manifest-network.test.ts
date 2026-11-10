import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import { RouteDockClient } from '../RouteDockClient.js'
import { X402Client } from '../x402Client.js'
import { MppChargeClient } from '../MppChargeClient.js'
import { MppSessionClient } from '../MppSessionClient.js'
import { RouteDockManifestError } from '../../errors.js'
import { signManifest } from '../../manifest/sign.js'
import type { PaymentResult, RouteDockManifest, SessionHandle } from '../../types.js'

const TESTNET_USDC_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const MAINNET_USDC_CONTRACT = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'
const TEST_CHANNEL_CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4'

function startManifestServer(
  manifest: RouteDockManifest,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url === '/.well-known/routedock.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(manifest))
        return
      }
      res.writeHead(404)
      res.end()
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise<void>((res) => server.close(() => res())),
      })
    })
  })
}

function buildSignedManifest(network: 'testnet' | 'mainnet'): RouteDockManifest {
  const payee = Keypair.random()
  const unsigned: RouteDockManifest = {
    routedock: '1.0',
    name: `Network Test Provider (${network})`,
    description: 'Verifies RouteDockClient enforces manifest.network against client network',
    modes: ['x402', 'mpp-charge', 'mpp-session'],
    network,
    asset: 'USDC',
    asset_contract: network === 'mainnet' ? MAINNET_USDC_CONTRACT : TESTNET_USDC_CONTRACT,
    payee: payee.publicKey(),
    pricing: {
      x402: {
        amount: '0.001',
        per: 'request',
        facilitator: 'https://channels.openzeppelin.com/x402',
      },
      'mpp-charge': {
        amount: '0.0008',
        per: 'request',
      },
      'mpp-session': {
        rate: '0.0001',
        per: 'voucher',
        min_deposit: '0.01',
        channel_factory: TEST_CHANNEL_CONTRACT,
        refund_waiting_period_ledgers: 100,
      },
    },
    endpoints: {
      quote: { method: 'GET', path: '/quote' },
      stream: { method: 'GET', path: '/stream' },
    },
    tags: ['test'],
  }
  return signManifest(unsigned, payee.secret())
}

describe('RouteDockClient — manifest.network validation (#399)', () => {
  it('pay() on a mainnet client rejects a testnet manifest without calling X402 or MPP charge clients', async (t) => {
    const srv = await startManifestServer(buildSignedManifest('testnet'))
    try {
      let x402Calls = 0
      let chargeCalls = 0
      t.mock.method(X402Client.prototype, 'pay', async () => {
        x402Calls++
        return {} as PaymentResult
      })
      t.mock.method(MppChargeClient.prototype, 'pay', async () => {
        chargeCalls++
        return {} as PaymentResult
      })

      const client = new RouteDockClient({
        wallet: Keypair.random(),
        network: 'mainnet',
      })

      await assert.rejects(
        () => client.pay(`${srv.url}/quote`),
        (err: unknown) => {
          assert.ok(err instanceof RouteDockManifestError)
          assert.ok(err.message.includes(srv.url))
          assert.ok(err.message.includes('"testnet"'))
          assert.ok(err.message.includes('"mainnet"'))
          return true
        },
      )

      assert.equal(x402Calls, 0)
      assert.equal(chargeCalls, 0)
    } finally {
      await srv.close()
    }
  })

  it('openSession() on a mainnet client rejects a testnet manifest without calling MppSessionClient', async (t) => {
    const srv = await startManifestServer(buildSignedManifest('testnet'))
    try {
      let sessionCalls = 0
      t.mock.method(MppSessionClient.prototype, 'openSession', async () => {
        sessionCalls++
        return {} as SessionHandle
      })

      const client = new RouteDockClient({
        wallet: Keypair.random(),
        network: 'mainnet',
        commitmentSecret: Keypair.random().secret(),
      })

      await assert.rejects(
        () => client.openSession(`${srv.url}/stream`),
        (err: unknown) => {
          assert.ok(err instanceof RouteDockManifestError)
          assert.ok(err.message.includes(srv.url))
          assert.ok(err.message.includes('"testnet"'))
          assert.ok(err.message.includes('"mainnet"'))
          return true
        },
      )

      assert.equal(sessionCalls, 0)
    } finally {
      await srv.close()
    }
  })

  it('estimateCost() (_resolveManifest) on a mainnet client rejects a testnet manifest', async () => {
    const srv = await startManifestServer(buildSignedManifest('testnet'))
    try {
      const client = new RouteDockClient({
        wallet: Keypair.random(),
        network: 'mainnet',
      })

      await assert.rejects(
        () => client.estimateCost(`${srv.url}/quote`),
        (err: unknown) => {
          assert.ok(err instanceof RouteDockManifestError)
          assert.ok(err.message.includes(srv.url))
          assert.ok(err.message.includes('"testnet"'))
          assert.ok(err.message.includes('"mainnet"'))
          return true
        },
      )
    } finally {
      await srv.close()
    }
  })

  it('testnet client rejects a mainnet manifest with RouteDockManifestError', async (t) => {
    const srv = await startManifestServer(buildSignedManifest('mainnet'))
    try {
      let chargeCalls = 0
      t.mock.method(MppChargeClient.prototype, 'pay', async () => {
        chargeCalls++
        return {} as PaymentResult
      })

      const client = new RouteDockClient({
        wallet: Keypair.random(),
        network: 'testnet',
      })

      await assert.rejects(
        () => client.pay(`${srv.url}/quote`),
        (err: unknown) => {
          assert.ok(err instanceof RouteDockManifestError)
          assert.ok(err.message.includes(srv.url))
          assert.ok(err.message.includes('"mainnet"'))
          assert.ok(err.message.includes('"testnet"'))
          return true
        },
      )

      assert.equal(chargeCalls, 0)
    } finally {
      await srv.close()
    }
  })

  it('matching network proceeds through estimateCost without throwing', async () => {
    const srv = await startManifestServer(buildSignedManifest('testnet'))
    try {
      const client = new RouteDockClient({
        wallet: Keypair.random(),
        network: 'testnet',
      })

      const estimate = await client.estimateCost(`${srv.url}/quote`)
      assert.equal(estimate.mode, 'mpp-charge')
      assert.equal(estimate.amount, '0.0008')
      assert.equal(estimate.manifest.network, 'testnet')
    } finally {
      await srv.close()
    }
  })
})
