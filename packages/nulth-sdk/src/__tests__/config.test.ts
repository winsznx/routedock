import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  NulthClient,
  NulthConfigError,
  createNulthSigner,
  createPolicyState,
  type NulthClientConfig,
  type NulthLogger,
} from '../index.js'

function config(): NulthClientConfig {
  return {
    nulthAccount: 'test-account',
    network: 'testnet',
    policy: createPolicyState({
      dailyCapUsdc: '1.00',
      allowedPayees: ['test-payee'],
      witnessSecret: 'private-witness',
    }),
  }
}

describe('Nulth configuration', () => {
  it('is silent when no logger is supplied to the client or signer', (t) => {
    // #given no configured logger and observable console methods
    const calls = (['debug', 'info', 'log', 'warn', 'error'] as const).map((level) =>
      t.mock.method(console, level, () => {}),
    )
    // #when constructing both public entry points
    new NulthClient(config())
    createNulthSigner(config())
    // #then no diagnostics escape to the console
    assert.deepEqual(calls.map((call) => call.mock.callCount()), [0, 0, 0, 0, 0])
  })

  for (const [name, create] of [
    ['client', (input: NulthClientConfig) => new NulthClient(input)],
    ['signer', createNulthSigner],
  ] as const) {
    it(`routes one mock-prover warning from the ${name} to the configured sink`, () => {
      // #given a caller-supplied structured logger
      const calls: Parameters<NulthLogger>[] = []
      const logger: NulthLogger = (...args) => { calls.push(args) }
      // #when constructing the client or signer
      create({ ...config(), logger })
      // #then only the public warning is logged, without private policy data
      assert.deepEqual(calls, [[
        'warn',
        'NulthClient is using the insecure mock prover; proofs are not cryptographically sound',
      ]])
    })
  }

  for (const network of ['mainnet', undefined, 'pubnet']) {
    it(`rejects network ${String(network)} with a typed configuration error`, () => {
      // #given an invalid runtime network, as can arrive from JavaScript
      const input = { ...config(), network } as unknown as NulthClientConfig
      // #when constructing #then callers can distinguish configuration failures
      assert.throws(() => new NulthClient(input), {
        name: 'NulthConfigError',
        code: 'unsupported_network',
      })
    })
  }

  it('rejects unknown provers before logging', () => {
    // #given a runtime prover unsupported by this package
    const input = { ...config(), prover: 'wasm' } as unknown as NulthClientConfig
    let calls = 0
    input.logger = () => { calls++ }
    // #when constructing #then the typed failure precedes diagnostics
    assert.throws(() => new NulthClient(input), (error: unknown) =>
      error instanceof NulthConfigError && error.code === 'unsupported_prover',
    )
    assert.equal(calls, 0)
  })
})
