import type { SeenTxStore } from '../SeenTxStore.js'
import { normalizeNanoAddress, nanoAddressFromPublicKey } from './address.js'

/**
 * `exact` payments on `nano:mainnet`, verified against a Nano node the
 * operator configures. Opt-in: nothing here runs unless a provider calls
 * {@link createNanoExact}.
 *
 * Binding: a Nano block has no memo, so each 402 carries a fresh random
 * `orderId` and a commitment account
 * `SHA-256("xno-binding/v1/rep|" + orderId + "|" + payTo + "|" + amountRaw)`
 * that the payer puts in the send block's `representative` field. The block
 * therefore commits to this order, this payee and this price, and only the
 * party that received the `orderId` can present it.
 *
 * Replay: an accepted block hash is claimed in the {@link SeenTxStore} and
 * any later presentation of it is refused. The store is required (there is
 * no in-memory default) so that a durable store keeps the refusal across a
 * restart.
 *
 * No key or seed is involved: the verifier only reads `block_info`.
 */

export const NANO_MAINNET = 'nano:mainnet'
export const NANO_EXACT_SCHEME = 'exact'
export const NANO_BINDING = 'xno-binding/v1/rep'

/** 1 XNO in raw, the integer unit of every Nano amount. */
export const RAW_PER_XNO = 10n ** 30n

const MAX_RAW = (1n << 128n) - 1n
const RAW_RE = /^[1-9][0-9]*$/
const XNO_RE = /^([0-9]+)(?:\.([0-9]{1,30}))?$/
const BLOCK_HASH_RE = /^[0-9A-Fa-f]{64}$/
const ORDER_ID_RE = /^[0-9a-f]{32}$/
const MAX_RPC_BYTES = 64 * 1024
const DEFAULT_TIMEOUT_MS = 10_000
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** Convert a decimal XNO string (e.g. `"0.05"`) to raw. Integers only, no floats. */
export function xnoToRaw(xno: string): string {
  const m = XNO_RE.exec(xno)
  if (m === null) throw new RangeError(`not a decimal XNO amount: ${xno}`)
  const whole = BigInt(m[1] ?? '0')
  const frac = BigInt((m[2] ?? '').padEnd(30, '0'))
  const raw = whole * RAW_PER_XNO + frac
  if (raw <= 0n || raw > MAX_RAW) throw new RangeError(`XNO amount out of range: ${xno}`)
  return raw.toString()
}

function assertRaw(amountRaw: string): void {
  if (!RAW_RE.test(amountRaw) || BigInt(amountRaw) > MAX_RAW) {
    throw new RangeError(`not a raw amount: ${amountRaw}`)
  }
}

/** A fresh opaque order id: 128 random bits as lowercase hex. */
export function newNanoOrderId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** The `representative` account a payment for this order must carry. */
export async function nanoOrderCommitment(
  orderId: string,
  payTo: string,
  amountRaw: string,
): Promise<string> {
  const text = `${NANO_BINDING}|${orderId}|${payTo}|${amountRaw}`
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return nanoAddressFromPublicKey(new Uint8Array(digest))
}

/** One entry of an x402 `accepts` list for `nano:mainnet`. */
export interface NanoExactRequirement {
  scheme: typeof NANO_EXACT_SCHEME
  network: typeof NANO_MAINNET
  asset: 'XNO'
  /** Price in raw (1 XNO = 10^30 raw). */
  amount: string
  payTo: string
  maxTimeoutSeconds: number
  extra: {
    binding: typeof NANO_BINDING
    orderId: string
    /** Account the send block's `representative` must be set to. */
    representative: string
  }
}

/** What the payer sends back after its send block is confirmed. */
export interface NanoExactPayload {
  blockHash: string
  orderId: string
}

export type NanoExactRefusal =
  | 'malformed-payload'
  | 'spent'
  | 'node-error'
  | 'not-found'
  | 'unconfirmed'
  | 'not-a-send'
  | 'wrong-destination'
  | 'wrong-amount'
  | 'not-bound-to-order'
  | 'store-error'

export type NanoExactResult =
  | { ok: true; txHash: string; amount: string; payer: string }
  | { ok: false; reason: NanoExactRefusal }

export interface NanoExactOptions {
  /** Account that receives payments. Must be a checksum-valid address. */
  payTo: string
  /** Nano node RPC URL. https, or http on a loopback host only. */
  nodeUrl: string
  /**
   * Claims accepted block hashes. Required: pass a durable store (Supabase,
   * Redis, ...) so a block cannot be spent again after a restart. Concurrent
   * presentations are serialised per process; across instances, use a store
   * shared by all of them.
   */
  seenTxStore: SeenTxStore
  /** Seconds a payer has to pay after the 402. Defaults to 600. */
  maxTimeoutSeconds?: number
  /** RPC timeout. Defaults to 10 s. */
  timeoutMs?: number
  /** Injected for tests; defaults to the global `fetch`. */
  fetch?: typeof fetch
}

export interface NanoExact {
  /** Build the requirement for one order at `amountRaw`. */
  requirement(amountRaw: string, orderId?: string): Promise<NanoExactRequirement>
  /** Verify a payload against the price of the route it was presented on. */
  verify(payload: unknown, amountRaw: string): Promise<NanoExactResult>
}

interface BlockInfo {
  error?: unknown
  amount?: unknown
  confirmed?: unknown
  subtype?: unknown
  block_account?: unknown
  contents?: { link_as_account?: unknown; representative?: unknown } | null
}

function parsePayload(payload: unknown): NanoExactPayload | null {
  if (typeof payload !== 'object' || payload === null) return null
  const { blockHash, orderId } = payload as Record<string, unknown>
  if (typeof blockHash !== 'string' || !BLOCK_HASH_RE.test(blockHash)) return null
  if (typeof orderId !== 'string' || !ORDER_ID_RE.test(orderId)) return null
  return { blockHash: blockHash.toUpperCase(), orderId }
}

function assertNodeUrl(nodeUrl: string): void {
  let url: URL
  try {
    url = new URL(nodeUrl)
  } catch {
    throw new RangeError(`nano nodeUrl is not a URL: ${nodeUrl}`)
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new RangeError('nano nodeUrl must be https (plain http only on a loopback host)')
  }
}

export function createNanoExact(opts: NanoExactOptions): NanoExact {
  const normalizedPayTo = normalizeNanoAddress(opts.payTo)
  if (normalizedPayTo === null) {
    throw new RangeError(`nano payTo fails the address checksum: ${opts.payTo}`)
  }
  const payTo: string = normalizedPayTo
  assertNodeUrl(opts.nodeUrl)
  if (!opts.seenTxStore) throw new TypeError('nano: a seenTxStore is required')
  const store = opts.seenTxStore
  const doFetch = opts.fetch ?? fetch
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxTimeoutSeconds = opts.maxTimeoutSeconds ?? 600
  const inFlight = new Set<string>()

  async function readBlock(hash: string): Promise<BlockInfo | null> {
    try {
      const res = await doFetch(opts.nodeUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'block_info', json_block: 'true', hash }),
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!res.ok) return null
      const text = await res.text()
      if (text.length > MAX_RPC_BYTES) return null
      const body: unknown = JSON.parse(text)
      return typeof body === 'object' && body !== null ? (body as BlockInfo) : null
    } catch {
      // Network failure, timeout or a non-JSON body: the payment is unverified, never accepted.
      return null
    }
  }

  async function check(p: NanoExactPayload, amountRaw: string): Promise<NanoExactResult> {
    const key = `nano:exact:${p.blockHash}`
    let seen: unknown
    try {
      seen = await store.get(key)
    } catch {
      return { ok: false, reason: 'store-error' }
    }
    if (seen !== undefined) return { ok: false, reason: 'spent' }

    const block = await readBlock(p.blockHash)
    if (block === null) return { ok: false, reason: 'node-error' }
    if (block.error !== undefined) return { ok: false, reason: 'not-found' }
    if (block.confirmed !== 'true' && block.confirmed !== true) return { ok: false, reason: 'unconfirmed' }
    if (block.subtype !== 'send') return { ok: false, reason: 'not-a-send' }

    const destination =
      typeof block.contents?.link_as_account === 'string'
        ? normalizeNanoAddress(block.contents.link_as_account)
        : null
    if (destination !== payTo) return { ok: false, reason: 'wrong-destination' }
    if (typeof block.amount !== 'string' || !RAW_RE.test(block.amount) || block.amount !== amountRaw) {
      return { ok: false, reason: 'wrong-amount' }
    }

    const representative =
      typeof block.contents?.representative === 'string'
        ? normalizeNanoAddress(block.contents.representative)
        : null
    const commitment = await nanoOrderCommitment(p.orderId, payTo, amountRaw)
    if (representative !== commitment) return { ok: false, reason: 'not-bound-to-order' }

    try {
      await store.set(key, { txHash: p.blockHash, createdAt: Date.now() })
    } catch {
      // Without a recorded claim the block could be spent twice, so it is not accepted now.
      return { ok: false, reason: 'store-error' }
    }
    const payer = typeof block.block_account === 'string' ? block.block_account : ''
    return { ok: true, txHash: p.blockHash, amount: amountRaw, payer }
  }

  return {
    async requirement(amountRaw, orderId = newNanoOrderId()) {
      assertRaw(amountRaw)
      if (!ORDER_ID_RE.test(orderId)) throw new RangeError('nano orderId must be 32 lowercase hex characters')
      return {
        scheme: NANO_EXACT_SCHEME,
        network: NANO_MAINNET,
        asset: 'XNO',
        amount: amountRaw,
        payTo: payTo,
        maxTimeoutSeconds,
        extra: {
          binding: NANO_BINDING,
          orderId,
          representative: await nanoOrderCommitment(orderId, payTo, amountRaw),
        },
      }
    },

    async verify(payload, amountRaw) {
      assertRaw(amountRaw)
      const p = parsePayload(payload)
      if (p === null) return { ok: false, reason: 'malformed-payload' }
      // Two concurrent presentations of one block in this process: only the first is checked.
      if (inFlight.has(p.blockHash)) return { ok: false, reason: 'spent' }
      inFlight.add(p.blockHash)
      try {
        return await check(p, amountRaw)
      } finally {
        inFlight.delete(p.blockHash)
      }
    },
  }
}
