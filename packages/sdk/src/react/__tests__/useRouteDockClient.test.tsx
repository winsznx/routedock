import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
GlobalRegistrator.register()
import * as RTL from '@testing-library/react'
const { renderHook } = RTL
import { Keypair } from '@stellar/stellar-sdk'
import { useRouteDockClient } from '../useRouteDockClient.js'
import { RouteDockClient } from '../../client/RouteDockClient.js'
import { signManifest } from '../../manifest/sign.js'
import type { RouteDockManifest, SessionHandle } from '../../types.js'

const TESTNET_USDC_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const TEST_CHANNEL_CONTRACT = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4'

function startTestServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*')
      handler(req, res)
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

function makeSignedSessionManifest(): RouteDockManifest {
  const payee = Keypair.random()
  const unsigned: RouteDockManifest = {
    routedock: '1.0',
    name: 'StrictMode Session Provider',
    description: 'Verifies commitmentSecret survives StrictMode effect replay',
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

describe('useRouteDockClient', () => {
  it('returns a memoized RouteDockClient instance', () => {
    const secret = Keypair.random().secret()
    const { result, rerender } = renderHook(() =>
      useRouteDockClient({ wallet: secret, network: 'testnet' }),
    )
    const first = result.current

    rerender()

    assert.ok(first instanceof RouteDockClient)
    assert.equal(result.current, first, 'identity is stable across rerenders')
  })

  it('rebuilds when wallet changes', () => {
    const a = Keypair.random().secret()
    const b = Keypair.random().secret()
    const { result, rerender } = renderHook(
      ({ secret }: { secret: string }) =>
        useRouteDockClient({ wallet: secret, network: 'testnet' }),
      { initialProps: { secret: a } },
    )
    const first = result.current

    rerender({ secret: b })

    assert.notEqual(result.current, first)
  })

  it('preserves commitmentSecret under React StrictMode so openSession() succeeds', async () => {
    const manifest = makeSignedSessionManifest()
    const server = await startTestServer((req, res) => {
      if (req.url === '/.well-known/routedock.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(manifest))
        return
      }
      res.writeHead(404)
      res.end()
    })

    try {
      const walletSecret = Keypair.random().secret()
      const commitmentSecret = Keypair.random().secret()
      const { result } = renderHook(
        () =>
          useRouteDockClient({
            wallet: walletSecret,
            network: 'testnet',
            commitmentSecret,
          }),
        { reactStrictMode: true },
      )

      const client = result.current
      let stubCalls = 0
      const fakeHandle = { channelId: 'C_STRICT' } as unknown as SessionHandle
      ;(client as unknown as { _checkTrustline: () => Promise<void> })._checkTrustline = async () => {}
      ;(client as unknown as { session: { openSession: () => Promise<SessionHandle> } }).session.openSession =
        async () => {
          stubCalls++
          return fakeHandle
        }

      const handle = await client.openSession(`${server.url}/stream`)
      assert.equal(stubCalls, 1)
      assert.equal(handle, fakeHandle)
    } finally {
      await server.close()
    }
  })

  it('never calls dispose() on the mounted client under React StrictMode', () => {
    const originalDispose = RouteDockClient.prototype.dispose
    const disposedInstances: RouteDockClient[] = []
    RouteDockClient.prototype.dispose = function (this: RouteDockClient) {
      disposedInstances.push(this)
      return originalDispose.call(this)
    }

    try {
      const secret = Keypair.random().secret()
      const commitmentSecret = Keypair.random().secret()
      const { result } = renderHook(
        () =>
          useRouteDockClient({
            wallet: secret,
            network: 'testnet',
            commitmentSecret,
          }),
        { reactStrictMode: true },
      )

      assert.equal(
        disposedInstances.filter((inst) => inst === result.current).length,
        0,
      )
    } finally {
      RouteDockClient.prototype.dispose = originalDispose
    }
  })

  it('disposes the previous client once when wallet changes and keeps the new client active', () => {
    const originalDispose = RouteDockClient.prototype.dispose
    const disposedInstances: RouteDockClient[] = []
    RouteDockClient.prototype.dispose = function (this: RouteDockClient) {
      disposedInstances.push(this)
      return originalDispose.call(this)
    }

    try {
      const a = Keypair.random().secret()
      const b = Keypair.random().secret()
      const commitmentSecret = Keypair.random().secret()
      const { result, rerender } = renderHook(
        ({ secret }: { secret: string }) =>
          useRouteDockClient({
            wallet: secret,
            network: 'testnet',
            commitmentSecret,
          }),
        { initialProps: { secret: a }, reactStrictMode: true },
      )
      const first = result.current

      rerender({ secret: b })
      const second = result.current

      assert.notEqual(second, first)
      assert.equal(disposedInstances.filter((inst) => inst === first).length, 1)
      assert.equal(disposedInstances.filter((inst) => inst === second).length, 0)
    } finally {
      RouteDockClient.prototype.dispose = originalDispose
    }
  })
})
