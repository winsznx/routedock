import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import type { RouteDockManifest } from '../../types.js'
import type { ChannelStore } from '../MppSessionHandler.js'

const payeeKeypair = Keypair.random()
const commitKeypair = Keypair.random()

const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const CHANNEL_CONTRACT = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'

let capturedStore: ChannelStore | null = null
let memoryStoreFactory: () => ChannelStore = () => ({
  async get() { return null },
  async put() {},
  async delete() {},
})

const captureChannelOpts = (opts: { store: ChannelStore }) => {
  capturedStore = opts.store
  return []
}

mock.module('@stellar/mpp/channel/server', {
  namedExports: {
    Store: {
      memory: () => memoryStoreFactory(),
    },
    close: async () => 'mock-close-tx-hash',
    stellar: Object.assign(captureChannelOpts, {
      channel: captureChannelOpts,
    }),
  },
})

const actualCompat = await import('../mppCompatibility.js')
mock.module('../mppCompatibility.js', {
  namedExports: {
    channelAuthorizer: actualCompat.channelAuthorizer,
    withTypedChannelErrors: actualCompat.withTypedChannelErrors,
    formatMppError: actualCompat.formatMppError,
    onVerifiedCredential: (m: unknown) => m,
  },
})

const { routedockHono } = await import('../hono.js')
const { createMppSessionHandler } = await import('../MppSessionHandler.js')

const manifest: RouteDockManifest = {
  routedock: '1.0',
  name: 'WrappedStore Test Service',
  description: 'Unit test provider',
  modes: ['mpp-session'],
  network: 'testnet',
  asset: 'USDC',
  asset_contract: ASSET_CONTRACT,
  payee: payeeKeypair.publicKey(),
  pricing: {
    'mpp-session': {
      rate: '0.0001',
      per: 'voucher',
      channel_factory: CHANNEL_CONTRACT,
      min_deposit: '0.10',
      refund_waiting_period_ledgers: 17280,
    },
  },
  endpoints: { price: { method: 'GET', path: '/price' } },
  tags: ['test'],
}

describe('routedockHono wrappedStore.update()', () => {
  it('delegates to sessionStore.update when sessionStore provides update', async () => {
    let updateCalledWithKey: string | null = null
    const sessionStore: ChannelStore = {
      async get() { return null },
      async put() {},
      async delete() {},
      async update(key: string, fn: (prev: unknown) => unknown) {
        updateCalledWithKey = key
        return fn({ amount: '100' })
      },
    }

    capturedStore = null
    routedockHono({
      asset: 'USDC',
      assetContract: ASSET_CONTRACT,
      payee: payeeKeypair.publicKey(),
      network: 'testnet',
      payeeSecretKey: payeeKeypair.secret(),
      commitmentPublicKey: commitKeypair.publicKey(),
      manifest,
      modes: ['mpp-session'],
      pricing: { 'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT } },
      sessionStore,
    })

    const store = capturedStore as ChannelStore | null
    assert.ok(store, 'routedockHono should pass wrappedStore to stellar channel method')
    const result = await store.update!('test-key', (prev: unknown) => prev)
    assert.equal(updateCalledWithKey, 'test-key')
    assert.deepEqual(result, { amount: '100' })
  })

  it('rejects when sessionStore omits update', async () => {
    const basicStore = {
      async get() { return null },
      async put() {},
      async delete() {},
    }

    capturedStore = null
    routedockHono({
      asset: 'USDC',
      assetContract: ASSET_CONTRACT,
      payee: payeeKeypair.publicKey(),
      network: 'testnet',
      payeeSecretKey: payeeKeypair.secret(),
      commitmentPublicKey: commitKeypair.publicKey(),
      manifest,
      modes: ['mpp-session'],
      pricing: { 'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT } },
      sessionStore: basicStore,
    })

    const store = capturedStore as ChannelStore | null
    assert.ok(store, 'routedockHono should pass wrappedStore to stellar channel method')
    await assert.rejects(
      async () => {
        await store.update!('key', (prev: unknown) => prev)
      },
      {
        name: 'Error',
        message: 'Store does not support atomic update operations',
      },
    )
  })
})

describe('createMppSessionHandler wrappedStore.update()', () => {
  it('delegates to innerStore.update when Store.memory() provides update', async () => {
    let updateCalledWithKey: string | null = null
    memoryStoreFactory = () => ({
      async get() { return null },
      async put() {},
      async delete() {},
      async update(key: string, fn: (prev: unknown) => unknown) {
        updateCalledWithKey = key
        return fn({ amount: '200' })
      },
    })

    capturedStore = null
    createMppSessionHandler({
      payeeSecretKey: payeeKeypair.secret(),
      network: 'testnet',
      channelFactory: CHANNEL_CONTRACT,
      rate: '0.0001',
      assetContract: ASSET_CONTRACT,
      manifest,
      commitmentPublicKey: commitKeypair.publicKey(),
    })

    const store = capturedStore as ChannelStore | null
    assert.ok(store, 'createMppSessionHandler should pass wrappedStore to stellar.channel')
    const result = await store.update!('express-key', (prev: unknown) => prev)
    assert.equal(updateCalledWithKey, 'express-key')
    assert.deepEqual(result, { amount: '200' })
  })

  it('rejects when Store.memory() omits update', async () => {
    memoryStoreFactory = () => ({
      async get() { return null },
      async put() {},
      async delete() {},
    })

    capturedStore = null
    createMppSessionHandler({
      payeeSecretKey: payeeKeypair.secret(),
      network: 'testnet',
      channelFactory: CHANNEL_CONTRACT,
      rate: '0.0001',
      assetContract: ASSET_CONTRACT,
      manifest,
      commitmentPublicKey: commitKeypair.publicKey(),
    })

    const store = capturedStore as ChannelStore | null
    assert.ok(store, 'createMppSessionHandler should pass wrappedStore to stellar.channel')
    await assert.rejects(
      async () => {
        await store.update!('express-key', (prev: unknown) => prev)
      },
      {
        name: 'Error',
        message: 'Store does not support atomic update operations',
      },
    )
  })
})
