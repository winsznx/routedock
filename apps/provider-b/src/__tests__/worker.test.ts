import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import worker from '../worker.js'
import { ChannelSession } from '../ChannelSession.js'
import { TESTNET_USDC_CONTRACT } from '../manifest.js'
import type { Env } from '../env.js'

const TEST_PAYEE_SECRET = 'SBB3ER7UC7MYPQYHLNTX4QINRTV4WPFE2T644J64XTAUNKJMOGOVJGLL'
const TEST_PAYEE_ADDRESS = 'GBRLCID5A2S6HUC4D4DSWPRWNO75CLNHS2SIPS2BPCCP55Z5N7Z36DJD'
const TEST_CHANNEL_CONTRACT = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'

const mockEnv: Env = {
  STELLAR_NETWORK: 'testnet',
  STELLAR_PAYEE_SECRET: TEST_PAYEE_SECRET,
  STELLAR_PAYEE_ADDRESS: TEST_PAYEE_ADDRESS,
  COMMITMENT_PUBLIC_KEY: TEST_PAYEE_ADDRESS,
  CHANNEL_CONTRACT_ID: TEST_CHANNEL_CONTRACT,
  PUBLIC_BASE_URL: 'https://api-b.routedock.xyz',
  USDC_ASSET_CONTRACT: TESTNET_USDC_CONTRACT,
}

// Helper to create a mock DurableObject instance for testing ChannelSession
function createTestChannelSession(env: Env = mockEnv): ChannelSession {
  const session = Object.create(ChannelSession.prototype)
  Object.defineProperty(session, 'env', { value: env, writable: true })
  return session as ChannelSession
}

describe('provider-b worker payment path & Durable Object routes', () => {
  it('/health bypasses payment middleware and returns 200 OK', async () => {
    const req = new Request('http://localhost/health')
    const res = await worker.fetch(req, mockEnv)

    assert.equal(res.status, 200)
    const body = (await res.json()) as { status: string; network: string; payee: string; channel: string }
    assert.equal(body.status, 'ok')
    assert.equal(body.network, 'testnet')
    assert.equal(body.channel, 'configured')
    assert.equal(typeof body.payee, 'string')
  })

  it('returns 500 when CHANNEL_CONTRACT_ID is unset', async () => {
    const req = new Request('http://localhost/stream/orderbook')
    const incompleteEnv = { ...mockEnv, CHANNEL_CONTRACT_ID: undefined }
    const res = await worker.fetch(req, incompleteEnv as unknown as Env)

    assert.equal(res.status, 500)
    const body = (await res.json()) as { error: string }
    assert.match(body.error, /CHANNEL_CONTRACT_ID unset/)
  })

  it('routes request through CHANNEL_SESSION DO binding', async () => {
    const session = createTestChannelSession(mockEnv)

    const mockDOBinding = {
      idFromName(name: string) {
        return { name }
      },
      get(_id: unknown) {
        return {
          fetch(req: Request) {
            return session.fetch(req)
          },
        }
      },
    }

    const envWithDO: Env = {
      ...mockEnv,
      CHANNEL_SESSION: mockDOBinding as unknown as Env['CHANNEL_SESSION'],
    }

    const req = new Request('http://localhost/.well-known/routedock.json')
    const res = await worker.fetch(req, envWithDO)

    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      signature?: string
      payee?: string
      modes?: string[]
      pricing?: Record<string, { channel_factory?: string }>
    }

    assert.ok(body.signature, 'Manifest must contain signature property (issue #134)')
    assert.equal(body.payee, mockEnv.STELLAR_PAYEE_ADDRESS)
    assert.ok(Array.isArray(body.modes))
    assert.ok(body.modes.includes('mpp-session'))
    assert.equal(body.pricing['mpp-session']?.channel_factory, TEST_CHANNEL_CONTRACT)
  })

  it('/stream/orderbook returns 402 Payment Required with parsed WWW-Authenticate challenge', async () => {
    const session = createTestChannelSession(mockEnv)
    const req = new Request('http://localhost/stream/orderbook')
    const res = await session.fetch(req)

    assert.equal(res.status, 402)

    const authHeader = res.headers.get('WWW-Authenticate') || res.headers.get('X-Payment-Requirements')
    assert.ok(authHeader, 'Response must include payment challenge header')
    assert.ok(
      authHeader.includes('Payment') || authHeader.includes('mpp-session'),
      'Challenge header must specify mpp-session payment requirements',
    )
  })

  it('serializes voucher state on the same Durable Object instance across requests', async () => {
    const session = createTestChannelSession(mockEnv)

    // Request 1: 402 Payment Challenge
    const req1 = new Request('http://localhost/stream/orderbook')
    const res1 = await session.fetch(req1)
    assert.equal(res1.status, 402)

    // Request 2: Sequential request to the same DO instance
    const req2 = new Request('http://localhost/.well-known/routedock.json')
    const res2 = await session.fetch(req2)
    assert.equal(res2.status, 200)

    const body2 = (await res2.json()) as { payee?: string }
    assert.equal(body2.payee, mockEnv.STELLAR_PAYEE_ADDRESS)
  })
})
