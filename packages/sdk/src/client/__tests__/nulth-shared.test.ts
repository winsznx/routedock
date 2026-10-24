import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as shared from '@routedock/nulth-sdk'
import { rpc } from '@stellar/stellar-sdk'
import * as vault from '../NulthVault.js'
import { RouteDockManifestError } from '../../errors.js'
import { noopLogger, type RouteDockLogger } from '../../internal/logger.js'
import type { RouteDockManifest } from '../../types.js'

function config(): vault.NulthSignerConfig {
  return {
    nulthAccount: 'test-account',
    network: 'testnet',
    policy: vault.createPolicyState({
      dailyCapUsdc: '1.00',
      allowedPayees: ['test-payee'],
      witnessSecret: 'private-witness',
    }),
  }
}

const vaultConfig: vault.NulthVaultConfig = {
  mode: 'nulth',
  nulthAccount: 'test-account',
  allowedPayees: ['test-payee'],
  dailyCapUsdc: '1.00',
  witnessSecret: 'private-witness',
}

const manifest: RouteDockManifest = {
  routedock: '1.0',
  name: 'Test provider',
  description: 'Nulth adapter test',
  modes: ['x402'],
  network: 'testnet',
  asset: 'USDC',
  asset_contract: 'test-asset',
  payee: 'test-payee',
  pricing: { x402: { amount: '0.001', per: 'request' } },
  endpoints: {},
  tags: [],
}

describe('shared Nulth SDK adapter (#575)', () => {
  it('re-exports the shared helpers and policy error without copies', () => {
    // #given both package APIs #when comparing exports #then identity is shared
    for (const name of [
      'createPolicyState', 'paymentContextFromManifest', 'setNulthPaymentContext',
      'decodeAuthSignature', 'NulthPolicyError',
    ] as const) {
      assert.equal(vault[name], shared[name])
    }
  })

  it('retains the SDK console-backed logger default', (t) => {
    // #given no configured sink
    const warn = t.mock.method(console, 'warn', () => {})
    // #when constructing through the SDK adapter
    vault.createNulthSigner(config())
    // #then the existing default receives one warning
    assert.equal(warn.mock.callCount(), 1)
  })

  it('routes warnings to a custom SDK logger', (t) => {
    // #given a structured sink
    const warn = t.mock.method(console, 'warn', () => {})
    const calls: Parameters<RouteDockLogger>[] = []
    const logger: RouteDockLogger = (...args) => { calls.push(args) }
    // #when constructing #then no warning bypasses the sink
    vault.createNulthSigner({ ...config(), logger })
    assert.equal(warn.mock.callCount(), 0)
    assert.deepEqual(calls, [[
      'warn',
      'NulthClient is using the insecure mock prover; proofs are not cryptographically sound',
    ]])
  })

  it('lets a no-op SDK logger silence warnings', (t) => {
    // #given an explicitly silent sink
    const warn = t.mock.method(console, 'warn', () => {})
    // #when constructing #then there is no console warning
    vault.createNulthSigner({ ...config(), logger: noopLogger })
    assert.equal(warn.mock.callCount(), 0)
  })

  for (const invalid of [
    { network: 'mainnet' }, { network: undefined }, { network: 'pubnet' }, { prover: 'wasm' },
  ]) {
    it(`maps synchronous configuration failure ${JSON.stringify(invalid)} to a manifest error`, () => {
      // #given an invalid runtime config
      const input = { ...config(), ...invalid } as unknown as vault.NulthSignerConfig
      // #when creating a signer #then RouteDock callers retain their error contract
      assert.throws(() => vault.createNulthSigner(input), (error: unknown) =>
        error instanceof RouteDockManifestError && error.code === 'MANIFEST' &&
        !error.retryable && error.cause instanceof shared.NulthConfigError,
      )
    })
  }

  it('preserves logger exceptions instead of classifying them as manifest failures', () => {
    // #given a failing consumer sink
    const failure = new Error('sink unavailable')
    // #when logging #then the original failure escapes unchanged
    assert.throws(() => vault.createNulthSigner({
      ...config(), logger: () => { throw failure },
    }), (error: unknown) => error === failure)
  })

  it('reads the caller payment context after signer creation', async () => {
    // #given a signer created before a payment context exists
    const input = { ...config(), logger: noopLogger }
    const signer = vault.createNulthSigner(input)
    await assert.rejects(signer.signAuthEntry('invalid'), /paymentContext must be set/)
    // #when the original config gets its next payment
    vault.setNulthPaymentContext(input, {
      payee: 'test-payee', amountStroops: 1n, assetContract: 'test-asset', ledgerSequence: 1,
    })
    // #then the shared signer sees it and validates the entry, preserving policy errors
    await assert.rejects(signer.signAuthEntry('invalid'), (error: unknown) =>
      error instanceof shared.NulthPolicyError && error.code === 'auth_entry_mismatch',
    )
  })

  for (const network of [undefined, 'pubnet']) {
    it(`maps asynchronous preparation failure for network ${String(network)}`, async () => {
      // #given a ledger override so no RPC is required
      // #when preparing with invalid runtime input #then the error remains a manifest error
      await assert.rejects(vault.prepareNulthSigner(
        vaultConfig, manifest, 'x402', network as unknown as 'testnet', 1,
      ), (error: unknown) =>
        error instanceof RouteDockManifestError && error.cause instanceof shared.NulthConfigError,
      )
    })
  }

  it('rejects mainnet before attempting an RPC', async (t) => {
    // #given an RPC that must never be called for the insecure mainnet prover
    const latest = t.mock.method(rpc.Server.prototype, 'getLatestLedger', async () => {
      throw new Error('unexpected RPC')
    })
    // #when preparing without a ledger override #then the manifest guard fails first
    await assert.rejects(
      vault.prepareNulthSigner(vaultConfig, manifest, 'x402', 'mainnet'),
      RouteDockManifestError,
    )
    assert.equal(latest.mock.callCount(), 0)
  })

  it('preserves RPC failures when the ledger is unavailable', async (t) => {
    // #given an unavailable RPC and no ledger override
    const failure = new Error('ledger unavailable')
    t.mock.method(rpc.Server.prototype, 'getLatestLedger', async () => { throw failure })
    // #when preparing #then an RPC failure is not remapped as configuration failure
    await assert.rejects(
      vault.prepareNulthSigner(vaultConfig, manifest, 'x402', 'testnet'),
      (error: unknown) => error === failure,
    )
  })
})
