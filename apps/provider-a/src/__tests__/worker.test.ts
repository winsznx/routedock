import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import worker, { type Env } from '../worker.js'
import { TESTNET_USDC_CONTRACT } from '../manifest.js'

const mockCtx: ExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
}

const TEST_PAYEE_SECRET = 'SBB3ER7UC7MYPQYHLNTX4QINRTV4WPFE2T644J64XTAUNKJMOGOVJGLL'
const TEST_PAYEE_ADDRESS = 'GBRLCID5A2S6HUC4D4DSWPRWNO75CLNHS2SIPS2BPCCP55Z5N7Z36DJD'

const mockEnv: Env = {
  STELLAR_NETWORK: 'testnet',
  STELLAR_PAYEE_SECRET: TEST_PAYEE_SECRET,
  STELLAR_PAYEE_ADDRESS: TEST_PAYEE_ADDRESS,
  PUBLIC_BASE_URL: 'https://api-a.routedock.xyz',
  USDC_ASSET_CONTRACT: TESTNET_USDC_CONTRACT,
}

describe('provider-a worker payment path & routes', () => {
  it('/health bypasses payment middleware and returns 200 OK', async () => {
    const req = new Request('http://localhost/health')
    const res = await worker.fetch(req, mockEnv, mockCtx)

    assert.equal(res.status, 200)
    const body = (await res.json()) as { status: string; network: string; payee: string }
    assert.equal(body.status, 'ok')
    assert.equal(body.network, 'testnet')
    assert.equal(typeof body.payee, 'string')
  })

  it('/.well-known/routedock.json serves a signed manifest with status 200', async () => {
    const req = new Request('http://localhost/.well-known/routedock.json')
    const res = await worker.fetch(req, mockEnv, mockCtx)

    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      signature?: string
      payee?: string
      modes?: string[]
      pricing?: Record<string, unknown>
    }

    assert.ok(body.signature, 'Manifest must contain signature property (issue #134)')
    assert.equal(body.payee, mockEnv.STELLAR_PAYEE_ADDRESS)
    assert.ok(Array.isArray(body.modes))
    assert.ok(body.modes.includes('x402'))
    assert.ok(body.modes.includes('mpp-charge'))
  })

  it('/price returns 402 Payment Required with parsed WWW-Authenticate payment challenge', async () => {
    const req = new Request('http://localhost/price')
    const res = await worker.fetch(req, mockEnv, mockCtx)

    assert.equal(res.status, 402)

    // Verify WWW-Authenticate or X-Payment-Requirements header
    const authHeader = res.headers.get('WWW-Authenticate') || res.headers.get('X-Payment-Requirements')
    assert.ok(authHeader, 'Response must include payment challenge header')

    // Verify header contains Payment / mpp-charge / x402 details
    assert.ok(
      authHeader.includes('Payment') || authHeader.includes('x402') || authHeader.includes('mpp-charge'),
      'Challenge header must specify payment requirements',
    )
  })
})
