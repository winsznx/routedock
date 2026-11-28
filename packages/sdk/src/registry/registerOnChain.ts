import {
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  BASE_FEE,
  type Transaction,
} from '@stellar/stellar-sdk'
import { HORIZON_URLS } from '../network.js'

/** A Stellar account data entry value is limited to 64 bytes. */
export const MAX_DATA_ENTRY_BYTES = 64

export interface RegisterOnChainOptions {
  /** Secret key of the account that is also the provider's payee. */
  secret: string
  /** Provider origin, e.g. `https://api.example.com`. At most 64 bytes. */
  endpoint: string
  /** Optional capability tags, stored as a JSON array. At most 64 bytes encoded. */
  tags?: string[]
  network: 'testnet' | 'mainnet'
  /** Horizon override (defaults to the public host for `network`). */
  horizonUrl?: string
}

export interface RegisterOnChainResult {
  /** The registering account, which `OnChainRegistry` reports as the payee. */
  account: string
  hash: string
}

const byteLength = (value: string): number => new TextEncoder().encode(value).length

/**
 * Validate the values that go into the two data entries and return them.
 * `OnChainRegistry` reads `routedock_endpoint` (an http(s) URL) and
 * `routedock_tags` (a JSON array of strings); Stellar caps each value at 64
 * bytes, so a longer endpoint cannot be registered on-chain.
 */
export function buildRegistryEntries(
  endpoint: string,
  tags?: string[],
): { routedock_endpoint: string; routedock_tags?: string } {
  if (!endpoint.startsWith('http://') && !endpoint.startsWith('https://')) {
    throw new Error(`endpoint must be an http(s) URL (received "${endpoint}")`)
  }
  const endpointBytes = byteLength(endpoint)
  if (endpointBytes > MAX_DATA_ENTRY_BYTES) {
    throw new Error(
      `endpoint is ${endpointBytes} bytes, over the ${MAX_DATA_ENTRY_BYTES}-byte limit of a Stellar ` +
        'data entry value. Register a shorter origin (for example a short domain or a redirecting alias).',
    )
  }

  const entries: { routedock_endpoint: string; routedock_tags?: string } = {
    routedock_endpoint: endpoint,
  }
  if (tags && tags.length > 0) {
    if (!tags.every((t) => typeof t === 'string' && t.length > 0)) {
      throw new Error('tags must be non-empty strings')
    }
    const encoded = JSON.stringify(tags)
    const tagBytes = byteLength(encoded)
    if (tagBytes > MAX_DATA_ENTRY_BYTES) {
      throw new Error(
        `tags encode to ${tagBytes} bytes, over the ${MAX_DATA_ENTRY_BYTES}-byte limit of a Stellar ` +
          'data entry value. Use fewer or shorter tags.',
      )
    }
    entries.routedock_tags = encoded
  }
  return entries
}

/**
 * Build and sign (but not submit) the transaction that writes the registry
 * data entries. Split from {@link registerOnChain} so the validation and the
 * operations can be checked without a network.
 */
export function buildRegistrationTransaction(
  keypair: Keypair,
  sequenceAccount: ConstructorParameters<typeof TransactionBuilder>[0],
  options: Pick<RegisterOnChainOptions, 'endpoint' | 'tags' | 'network'>,
): Transaction {
  const entries = buildRegistryEntries(options.endpoint, options.tags)
  const builder = new TransactionBuilder(sequenceAccount, {
    fee: BASE_FEE,
    networkPassphrase: options.network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET,
  })
  builder.addOperation(
    Operation.manageData({ name: 'routedock_endpoint', value: entries.routedock_endpoint }),
  )
  builder.addOperation(
    // A null value deletes the entry, so re-registering without tags clears stale ones.
    Operation.manageData({ name: 'routedock_tags', value: entries.routedock_tags ?? null }),
  )
  const tx = builder.setTimeout(60).build()
  tx.sign(keypair)
  return tx
}

/**
 * Register a provider on the on-chain registry by writing the
 * `routedock_endpoint` and `routedock_tags` data entries on the account for
 * `secret`. That account becomes the provider's payee as far as
 * `ProviderRegistry` is concerned, so use the key that signs the manifest.
 * Add the account to the consumers' `knownAccounts` to make it discoverable.
 *
 * Throws before touching the network when the endpoint or tags exceed the
 * 64-byte limit of a Stellar data entry value.
 */
export async function registerOnChain(
  options: RegisterOnChainOptions,
): Promise<RegisterOnChainResult> {
  const keypair = Keypair.fromSecret(options.secret)
  // Validate first so an oversized value fails without a Horizon round trip.
  buildRegistryEntries(options.endpoint, options.tags)

  const horizonUrl = options.horizonUrl ?? HORIZON_URLS[options.network]
  const server = new Horizon.Server(horizonUrl, { allowHttp: horizonUrl.startsWith('http://') })
  const account = await server.loadAccount(keypair.publicKey())
  const tx = buildRegistrationTransaction(keypair, account, options)
  const result = await server.submitTransaction(tx)
  return { account: keypair.publicKey(), hash: result.hash }
}
