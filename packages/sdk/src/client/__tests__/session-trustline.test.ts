import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { Horizon, Keypair } from '@stellar/stellar-sdk'
import { RouteDockClient } from '../RouteDockClient.js'
import { MppSessionClient } from '../MppSessionClient.js'
import { RouteDockTrustlineError } from '../../errors.js'
import { USDC_ISSUERS } from '../../internal/usdc.js'
import { signManifest } from '../../manifest/sign.js'
import type { RouteDockManifest, SessionHandle } from '../../types.js'

const TESTNET_USDC_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
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

function buildSignedSessionManifest(): RouteDockManifest {
  const payee = Keypair.random()
  const unsigned: RouteDockManifest = {
    routedock: '1.0',
    name: 'Session Trustline Test Provider',
    description: 'Verifies openSession runs trustline preflight before opening a channel',
    modes: ['mpp-session'],
    network: 'testnet',
    asset: 'USDC',
    asset_contract: TESTNET_USDC_CONTRACT,
    payee: payee.publicKey(),
    pricing: {
      'mpp-session': {
        rate: '0.0001',
        per: 'voucher',
        min_deposit: '0.01',
        channel_factory: TEST_CHANNEL_CONTRACT,
        refund_waiting_period_ledgers: 100,
      },
    },
    endpoints: { stream: { method: 'GET', path: '/stream' } },
    tags: ['test'],
  }
  return signManifest(unsigned, payee.secret())
}

describe('RouteDockClient.openSession — trustline preflight (#402)', () => {
  it('rejects with RouteDockTrustlineError and does not open a channel when trustline is missing', async (t) => {
    const manifest = buildSignedSessionManifest()
    const srv = await startManifestServer(manifest)

    try {
      t.mock.method(Horizon.Server.prototype, 'loadAccount', async () => ({
        balances: [{ asset_type: 'native', balance: '10000.0000000' }],
      }))

      let sessionOpenCalls = 0
      t.mock.method(MppSessionClient.prototype, 'openSession', async () => {
        sessionOpenCalls++
        return {} as SessionHandle
      })

      const client = new RouteDockClient({
        wallet: Keypair.random(),
        network: 'testnet',
        commitmentSecret: Keypair.random().secret(),
      })

      await assert.rejects(
        () => client.openSession(`${srv.url}/stream`),
        (err: unknown) => {
          assert.ok(err instanceof RouteDockTrustlineError)
          assert.equal(err.asset, 'USDC')
          assert.equal(err.issuer, USDC_ISSUERS.testnet)
          return true
        },
      )

      assert.equal(sessionOpenCalls, 0)
    } finally {
      await srv.close()
    }
  })

  it('proceeds to MppSessionClient.openSession when the payer has a matching trustline', async (t) => {
    const manifest = buildSignedSessionManifest()
    const srv = await startManifestServer(manifest)

    try {
      t.mock.method(Horizon.Server.prototype, 'loadAccount', async () => ({
        balances: [
          { asset_type: 'native', balance: '10000.0000000' },
          {
            asset_type: 'credit_alphanum4',
            asset_code: 'USDC',
            asset_issuer: USDC_ISSUERS.testnet,
            balance: '50.0000000',
          },
        ],
      }))

      const fakeHandle = { channelId: 'ch_test_123' } as unknown as SessionHandle
      let sessionOpenCalls = 0
      t.mock.method(MppSessionClient.prototype, 'openSession', async () => {
        sessionOpenCalls++
        return fakeHandle
      })

      const client = new RouteDockClient({
        wallet: Keypair.random(),
        network: 'testnet',
        commitmentSecret: Keypair.random().secret(),
      })

      const handle = await client.openSession(`${srv.url}/stream`)
      assert.equal(sessionOpenCalls, 1)
      assert.equal(handle, fakeHandle)
    } finally {
      await srv.close()
    }
  })
})
