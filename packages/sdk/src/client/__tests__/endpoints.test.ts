import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveSorobanRpcUrl, resolveHorizonUrl } from '../endpoints.js'

test('resolveSorobanRpcUrl: an override wins over the network default', () => {
  assert.equal(
    resolveSorobanRpcUrl('mainnet', 'https://my-node.example'),
    'https://my-node.example',
  )
  assert.equal(
    resolveSorobanRpcUrl('testnet', 'https://my-node.example'),
    'https://my-node.example',
  )
})

test('resolveSorobanRpcUrl: falls back to the public endpoint per network', () => {
  assert.equal(resolveSorobanRpcUrl('mainnet'), 'https://soroban.stellar.org')
  assert.equal(resolveSorobanRpcUrl('testnet'), 'https://soroban-testnet.stellar.org')
})

test('resolveSorobanRpcUrl: an empty override falls back to the default', () => {
  assert.equal(resolveSorobanRpcUrl('mainnet', ''), 'https://soroban.stellar.org')
})

test('resolveHorizonUrl: an override wins over the network default', () => {
  assert.equal(
    resolveHorizonUrl('mainnet', 'https://my-horizon.example'),
    'https://my-horizon.example',
  )
})

test('resolveHorizonUrl: falls back to the public endpoint per network', () => {
  assert.equal(resolveHorizonUrl('mainnet'), 'https://horizon.stellar.org')
  assert.equal(resolveHorizonUrl('testnet'), 'https://horizon-testnet.stellar.org')
})
