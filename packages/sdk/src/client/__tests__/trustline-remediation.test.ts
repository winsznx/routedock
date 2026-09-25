import assert from 'node:assert/strict'
import test from 'node:test'
import { Asset, Horizon, Keypair, Networks, StrKey } from '@stellar/stellar-sdk'
import { RouteDockClient } from '../RouteDockClient.js'
import { RouteDockTrustlineError } from '../../errors.js'
import { USDC_ISSUERS } from '../../internal/usdc.js'
import type { RouteDockManifest } from '../../types.js'

const TESTNET_USDC_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const MAINNET_USDC_CONTRACT = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'

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
  const manifest: RouteDockManifest = {
    routedock: '1.0',
    name: 'Trustline Test Provider',
    description: 'Checks the testnet USDC trustline remediation',
    modes: ['x402'],
    network: 'testnet',
    asset: 'USDC',
    asset_contract: TESTNET_USDC_CONTRACT,
    payee: Keypair.random().publicKey(),
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
