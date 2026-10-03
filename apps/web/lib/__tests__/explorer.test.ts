import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  configuredNetwork,
  explorerHome,
  explorerUrl,
  networkLabel,
} from '../explorer'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('configuredNetwork', () => {
  it("returns 'testnet' when NEXT_PUBLIC_STELLAR_NETWORK is unset", () => {
    vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', '')
    expect(configuredNetwork()).toBe('testnet')
  })

  it("returns 'mainnet' when NEXT_PUBLIC_STELLAR_NETWORK is 'mainnet'", () => {
    vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', 'mainnet')
    expect(configuredNetwork()).toBe('mainnet')
  })

  it("returns 'testnet' for any value other than 'mainnet'", () => {
    vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', 'futurenet')
    expect(configuredNetwork()).toBe('testnet')
  })
})

describe('explorerHome', () => {
  it("maps 'mainnet' to stellar.expert's public network path", () => {
    expect(explorerHome('mainnet')).toBe('https://stellar.expert/explorer/public')
  })

  it("maps 'testnet' to the testnet path", () => {
    expect(explorerHome('testnet')).toBe('https://stellar.expert/explorer/testnet')
  })

  it('falls back to the configured network for undefined', () => {
    vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', 'mainnet')
    expect(explorerHome(undefined)).toBe('https://stellar.expert/explorer/public')

    vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', '')
    expect(explorerHome(undefined)).toBe('https://stellar.expert/explorer/testnet')
  })
})

describe('explorerUrl', () => {
  it('builds a tx URL for a mainnet row', () => {
    expect(explorerUrl('mainnet', 'tx', 'abc')).toBe(
      'https://stellar.expert/explorer/public/tx/abc',
    )
  })

  it('builds an account URL for a testnet row', () => {
    expect(explorerUrl('testnet', 'account', 'GABC')).toBe(
      'https://stellar.expert/explorer/testnet/account/GABC',
    )
  })

  it('keeps the row network when it differs from the configured network', () => {
    vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', 'mainnet')
    expect(explorerUrl('testnet', 'tx', 'abc')).toBe(
      'https://stellar.expert/explorer/testnet/tx/abc',
    )
  })

  it('uses the configured network when the network arg is undefined', () => {
    vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', 'mainnet')
    expect(explorerUrl(undefined, 'contract', 'CABC')).toBe(
      'https://stellar.expert/explorer/public/contract/CABC',
    )

    vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', '')
    expect(explorerUrl(undefined, 'contract', 'CABC')).toBe(
      'https://stellar.expert/explorer/testnet/contract/CABC',
    )
  })

  it('falls back to the configured network for unknown values', () => {
    expect(explorerUrl('futurenet', 'account', 'GABC')).toBe(
      'https://stellar.expert/explorer/testnet/account/GABC',
    )
    expect(explorerUrl('', 'tx', 'abc')).toBe(
      'https://stellar.expert/explorer/testnet/tx/abc',
    )
  })
})

describe('networkLabel', () => {
  it("returns 'Mainnet' for 'mainnet'", () => {
    expect(networkLabel('mainnet')).toBe('Mainnet')
  })

  it("returns 'Testnet' for 'testnet'", () => {
    expect(networkLabel('testnet')).toBe('Testnet')
  })

  it('resolves unknown values against the configured network', () => {
    vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', 'mainnet')
    expect(networkLabel(undefined)).toBe('Mainnet')

    vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', '')
    expect(networkLabel('futurenet')).toBe('Testnet')
  })
})
