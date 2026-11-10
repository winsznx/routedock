import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import assert from 'node:assert/strict'
import test from 'node:test'
import { Asset, Horizon, Keypair, Networks, StrKey } from '@stellar/stellar-sdk'
import { RouteDockClient } from '../RouteDockClient.js'
import { RouteDockTrustlineError } from '../../errors.js'
import { USDC_ISSUERS } from '../../internal/usdc.js'
import { signManifest } from '../../manifest/sign.js'
import type { PaymentResult, RouteDockManifest } from '../../types.js'
import type { RouteDockLogFields, RouteDockLogLevel } from '../ModeRouter.js'

const TESTNET_USDC_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const MAINNET_USDC_CONTRACT = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'

function buildManifest(payeeSecret?: string): RouteDockManifest {
  const payee = payeeSecret ? Keypair.fromSecret(payeeSecret) : Keypair.random()
  const unsigned: RouteDockManifest = {
    routedock: '1.0',
    name: 'Trustline Test Provider',
    description: 'Checks the testnet USDC trustline remediation',
    modes: ['x402'],
    network: 'testnet',
    asset: 'USDC',
    asset_contract: TESTNET_USDC_CONTRACT,
    payee: payee.publicKey(),
    pricing: {
      x402: {
        amount: '0.001',
        per: 'request',
        facilitator: 'https://channels.openzeppelin.com/x402/testnet',
      },
    },
    endpoints: { quote: { method: 'GET', path: '/quote' } },
    tags: ['test'],
  }
  return payeeSecret ? signManifest(unsigned, payeeSecret) : unsigned
}

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

test('USDC_ISSUERS contains valid issuers for testnet and mainnet', () => {
  assert.equal(StrKey.isValidEd25519PublicKey(USDC_ISSUERS.testnet), true)
  assert.equal(
    new Asset('USDC', USDC_ISSUERS.testnet).contractId(Networks.TESTNET),
    TESTNET_USDC_CONTRACT,
  )
  assert.equal(
    new Asset('USDC', USDC_ISSUERS.mainnet).contractId(Networks.PUBLIC),
    MAINNET_USDC_CONTRACT,
  )
})

test('missing-trustline remediation uses the canonical testnet USDC issuer', async (t) => {
  t.mock.method(Horizon.Server.prototype, 'loadAccount', async () => ({
    balances: [{ asset_type: 'native', balance: '10000.0000000' }],
  }))

  const payer = Keypair.random()
  const manifest = buildManifest()
  const client = new RouteDockClient({ wallet: payer, network: 'testnet' })

  await assert.rejects(
    client.preflight(manifest),
    (error: unknown) => {
      assert.ok(error instanceof RouteDockTrustlineError)
      assert.equal(error.issuer, USDC_ISSUERS.testnet)
      assert.ok(
        error.remediation.includes(
          `change-trust --asset USDC:${USDC_ISSUERS.testnet}`,
        ),
      )
      return true
    },
  )
})

test('preflight() and pay() throw RouteDockTrustlineError when payer account returns Horizon 404 (#563)', async (t) => {
  t.mock.method(Horizon.Server.prototype, 'loadAccount', async () => {
    const err = Object.assign(new Error('Resource Missing'), {
      name: 'NotFoundError',
      response: { status: 404 },
    })
    throw err
  })

  const payer = Keypair.random()
  const payee = Keypair.random()
  const manifest = buildManifest(payee.secret())
  const client = new RouteDockClient({ wallet: payer, network: 'testnet' })

  await assert.rejects(
    client.preflight(manifest),
    (error: unknown) => {
      assert.ok(error instanceof RouteDockTrustlineError)
      assert.equal(error.asset, 'USDC')
      assert.ok(error.remediation.includes(payer.publicKey()))
      assert.ok(error.remediation.includes('fund the account on testnet'))
      return true
    },
  )

  const srv = await startManifestServer(manifest)
  try {
    let x402Called = false
    ;(client as unknown as { x402: { pay: () => Promise<PaymentResult> } }).x402.pay = async () => {
      x402Called = true
      return {} as PaymentResult
    }

    await assert.rejects(
      client.pay(`${srv.url}/quote`),
      (error: unknown) => {
        assert.ok(error instanceof RouteDockTrustlineError)
        assert.ok(error.remediation.includes('fund the account on testnet'))
        return true
      },
    )
    assert.equal(x402Called, false)
  } finally {
    await srv.close()
  }
})

test('Horizon 5xx / timeout fails open and includes the error message in logger fields (#563)', async (t) => {
  t.mock.method(Horizon.Server.prototype, 'loadAccount', async () => {
    const err = Object.assign(new Error('Horizon 503 Service Unavailable'), {
      response: { status: 503 },
    })
    throw err
  })

  const logs: Array<{ level: RouteDockLogLevel; message: string; fields?: RouteDockLogFields }> = []
  const payer = Keypair.random()
  const manifest = buildManifest()
  const client = new RouteDockClient({
    wallet: payer,
    network: 'testnet',
    logger: (level, message, fields) => {
      logs.push({ level, message, ...(fields && { fields }) })
    },
  })

  const res = await client.preflight(manifest)
  assert.equal(res.hasTrustline, true)
  const warnLog = logs.find((entry) => entry.level === 'warn')
  assert.ok(warnLog, 'Expected warning log on transient Horizon failure')
  assert.equal(warnLog.fields?.error, 'Horizon 503 Service Unavailable')
})

test('preflight() succeeds and caches when payer account exists and has matching trustline (#563)', async (t) => {
  let loadAccountCalls = 0
  t.mock.method(Horizon.Server.prototype, 'loadAccount', async () => {
    loadAccountCalls++
    return {
      balances: [
        {
          asset_type: 'credit_alphanum4',
          asset_code: 'USDC',
          asset_issuer: USDC_ISSUERS.testnet,
          balance: '100.0000000',
        },
      ],
    }
  })

  const payer = Keypair.random()
  const manifest = buildManifest()
  const client = new RouteDockClient({ wallet: payer, network: 'testnet' })

  const res1 = await client.preflight(manifest)
  const res2 = await client.preflight(manifest)
  assert.equal(res1.hasTrustline, true)
  assert.equal(res2.hasTrustline, true)
  assert.equal(loadAccountCalls, 1)
})
