import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import path from 'node:path'
import os from 'node:os'
import {
  parseEnv,
  validateStellarNetwork,
  SERVER_NAME,
  SERVER_VERSION,
} from '../env.js'
import pkg from '../../package.json' with { type: 'json' }

describe('MCP Server version reporting', () => {
  it('reports the current package.json version rather than stale 0.1.0', () => {
    assert.strictEqual(SERVER_NAME, '@routedock/mcp-server')
    assert.strictEqual(SERVER_VERSION, pkg.version)
    assert.notStrictEqual(SERVER_VERSION, '0.1.0')
  })
})

describe('validateStellarNetwork', () => {
  it('defaults to testnet when networkInput is omitted or whitespace', () => {
    assert.strictEqual(validateStellarNetwork(undefined), 'testnet')
    assert.strictEqual(validateStellarNetwork(''), 'testnet')
    assert.strictEqual(validateStellarNetwork('   '), 'testnet')
  })

  it('accepts testnet and case-insensitive variants', () => {
    assert.strictEqual(validateStellarNetwork('testnet'), 'testnet')
    assert.strictEqual(validateStellarNetwork('TESTNET'), 'testnet')
    assert.strictEqual(validateStellarNetwork('  TestNet  '), 'testnet')
  })

  it('accepts mainnet and case-insensitive variants', () => {
    assert.strictEqual(validateStellarNetwork('mainnet'), 'mainnet')
    assert.strictEqual(validateStellarNetwork('MAINNET'), 'mainnet')
    assert.strictEqual(validateStellarNetwork('  MainNet  '), 'mainnet')
  })

  it('maps pubnet to mainnet with a warning', () => {
    const warnings: string[] = []
    const warn = (msg: string) => warnings.push(msg)

    assert.strictEqual(validateStellarNetwork('pubnet', warn), 'mainnet')
    assert.strictEqual(warnings.length, 1)
    assert.match(warnings[0] ?? '', /pubnet.*alias.*mainnet/i)

    warnings.length = 0
    assert.strictEqual(validateStellarNetwork('PUBNET', warn), 'mainnet')
    assert.strictEqual(warnings.length, 1)
  })

  it('maps public to mainnet with a warning', () => {
    const warnings: string[] = []
    const warn = (msg: string) => warnings.push(msg)

    assert.strictEqual(validateStellarNetwork('public', warn), 'mainnet')
    assert.strictEqual(warnings.length, 1)
    assert.match(warnings[0] ?? '', /public.*alias.*mainnet/i)

    warnings.length = 0
    assert.strictEqual(validateStellarNetwork('PUBLIC', warn), 'mainnet')
    assert.strictEqual(warnings.length, 1)
  })

  it('throws an error naming allowed values for invalid network strings', () => {
    assert.throws(
      () => validateStellarNetwork('invalid'),
      /Invalid STELLAR_NETWORK "invalid"\. Allowed values: testnet, mainnet/
    )
    assert.throws(
      () => validateStellarNetwork('futurenet'),
      /Invalid STELLAR_NETWORK "futurenet"\. Allowed values: testnet, mainnet/
    )
    assert.throws(
      () => validateStellarNetwork('local'),
      /Invalid STELLAR_NETWORK "local"\. Allowed values: testnet, mainnet/
    )
  })
})

describe('parseEnv', () => {
  const validBaseEnv = {
    STELLAR_SECRET: 'S_MOCK_STELLAR_SECRET',
    ROUTEDOCK_DAILY_CAP: '10.00',
  }

  it('parses valid minimal environment variables with testnet default', () => {
    const config = parseEnv(validBaseEnv)
    assert.strictEqual(config.stellarSecret, validBaseEnv.STELLAR_SECRET)
    assert.strictEqual(config.stellarNetwork, 'testnet')
    assert.strictEqual(config.routedockDailyCap, '10.00')
    assert.strictEqual(
      config.spendStorePath,
      path.join(os.homedir(), '.routedock', 'spend.json')
    )
    assert.strictEqual(config.commitmentSecret, undefined)
    assert.strictEqual(config.supabaseUrl, undefined)
    assert.strictEqual(config.supabaseKey, undefined)
  })

  it('uses ROUTEDOCK_WALLET_SECRET when STELLAR_SECRET is missing', () => {
    const config = parseEnv({
      ROUTEDOCK_WALLET_SECRET: 'S_WALLET_SECRET',
      ROUTEDOCK_DAILY_CAP: '5.00',
    })
    assert.strictEqual(config.stellarSecret, 'S_WALLET_SECRET')
    assert.strictEqual(config.routedockDailyCap, '5.00')
  })

  it('throws when secret is missing', () => {
    assert.throws(
      () => parseEnv({ ROUTEDOCK_DAILY_CAP: '10.00' }),
      /STELLAR_SECRET or ROUTEDOCK_WALLET_SECRET environment variable is required/
    )
  })

  it('throws when ROUTEDOCK_DAILY_CAP is missing', () => {
    assert.throws(
      () =>
        parseEnv({
          STELLAR_SECRET: 'S_SECRET',
        }),
      /ROUTEDOCK_DAILY_CAP environment variable is required to prevent unbounded spending/
    )
  })

  it('throws when STELLAR_NETWORK is invalid', () => {
    assert.throws(
      () =>
        parseEnv({
          ...validBaseEnv,
          STELLAR_NETWORK: 'invalid_net',
        }),
      /Invalid STELLAR_NETWORK "invalid_net"/
    )
  })

  it('accepts and maps STELLAR_NETWORK=pubnet with a warning', () => {
    const warnings: string[] = []
    const config = parseEnv(
      {
        ...validBaseEnv,
        STELLAR_NETWORK: 'pubnet',
      },
      { warn: (msg) => warnings.push(msg) }
    )

    assert.strictEqual(config.stellarNetwork, 'mainnet')
    assert.strictEqual(warnings.length, 1)
    assert.match(warnings[0] ?? '', /pubnet.*alias.*mainnet/i)
  })

  it('accepts explicit STELLAR_NETWORK=mainnet without warnings', () => {
    const warnings: string[] = []
    const config = parseEnv(
      {
        ...validBaseEnv,
        STELLAR_NETWORK: 'mainnet',
      },
      { warn: (msg) => warnings.push(msg) }
    )

    assert.strictEqual(config.stellarNetwork, 'mainnet')
    assert.strictEqual(warnings.length, 0)
  })

  it('warns when SUPABASE_SERVICE_KEY is supplied', () => {
    const warnings: string[] = []
    const config = parseEnv(
      {
        ...validBaseEnv,
        SUPABASE_URL: 'https://supabase.example.com',
        SUPABASE_SERVICE_KEY: 'sb_service_key',
      },
      { warn: (msg) => warnings.push(msg) }
    )

    assert.strictEqual(config.supabaseUrl, 'https://supabase.example.com')
    assert.strictEqual(config.supabaseKey, 'sb_service_key')
    assert.strictEqual(warnings.length, 1)
    assert.match(warnings[0] ?? '', /SUPABASE_SERVICE_KEY bypasses RLS/i)
  })

  it('respects custom ROUTEDOCK_SPEND_STORE_PATH and optional secrets', () => {
    const config = parseEnv({
      ...validBaseEnv,
      COMMITMENT_SECRET: 'S_COMMITMENT',
      ROUTEDOCK_SPEND_STORE_PATH: '/tmp/test-spend.json',
      SUPABASE_URL: 'https://test.supabase.co',
      SUPABASE_KEY: 'anon-key',
    })

    assert.strictEqual(config.commitmentSecret, 'S_COMMITMENT')
    assert.strictEqual(config.spendStorePath, '/tmp/test-spend.json')
    assert.strictEqual(config.supabaseUrl, 'https://test.supabase.co')
    assert.strictEqual(config.supabaseKey, 'anon-key')
  })
})
