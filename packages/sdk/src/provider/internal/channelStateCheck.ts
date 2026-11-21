import type { Method } from 'mppx'

/**
 * On-chain channel state check for mpp-session (issue #715).
 *
 * When enabled, `@stellar/mpp` reads the channel contract before accepting a
 * voucher and rejects it if the cumulative exceeds the channel balance or the
 * channel's close-effective ledger has passed. It also reports a pending
 * `close_start` (a refund dispute) through `onDisputeDetected`.
 *
 * Each check is one `getChannelState` call, which runs five Soroban RPC
 * simulations. `maxAgeMs` bounds that cost: while the cached
 * `stellar:channel:state:<channel>` entry is younger than `maxAgeMs` and shows
 * no dispute, the RPC read is skipped and the voucher is checked against the
 * cached balance instead.
 */
export interface ChannelStateCheckOptions {
  /** Run the on-chain check. Defaults to `true` on mainnet, `false` on testnet. */
  enabled: boolean
  /**
   * Skip the RPC read while the cached channel state is younger than this many
   * milliseconds. Unset means every voucher triggers a fresh read.
   */
  maxAgeMs?: number
}

type Network = 'testnet' | 'mainnet'

/** Applies the network default: the check is on for mainnet unless turned off. */
export function resolveChannelStateCheck(
  option: ChannelStateCheckOptions | undefined,
  network: Network,
): ChannelStateCheckOptions {
  if (option) return option
  return { enabled: network === 'mainnet' }
}

/** Store key mppx checks before accepting any credential for a channel. */
export function channelClosedKey(channel: string): string {
  return `stellar:channel:closed:${channel}`
}

/** Store key mppx caches the last on-chain channel state under. */
export function channelStateKey(channel: string): string {
  return `stellar:channel:state:${channel}`
}

/**
 * Value written under {@link channelClosedKey} after a close RouteDock
 * broadcasts itself. Same shape mppx writes when it performs the close.
 */
export function channelClosedMarker(txHash: string, amount: bigint): {
  closedAt: string
  txHash: string
  amount: string
} {
  return { closedAt: new Date().toISOString(), txHash, amount: amount.toString() }
}

/** The parts of a verify call this module reads. */
interface VerifyParameters {
  credential: { payload?: { action?: unknown; amount?: unknown } }
  request: unknown
}

interface CachedChannelState {
  balance: bigint
  queriedAt: number
}

/** Reads the cached on-chain state, or null when absent, malformed or disputed. */
async function readUndisputedCachedState(
  store: { get(key: string): Promise<unknown> },
  channel: string,
): Promise<CachedChannelState | null> {
  let raw: unknown
  try {
    raw = await store.get(channelStateKey(channel))
  } catch {
    // An unreadable cache is treated as a miss, so the full check runs.
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const entry = raw as { balance?: unknown; closeEffectiveAtLedger?: unknown; queriedAt?: unknown }
  if (entry.closeEffectiveAtLedger != null) return null
  if (typeof entry.balance !== 'string' || !/^\d+$/.test(entry.balance)) return null
  if (typeof entry.queriedAt !== 'string') return null
  const queriedAt = Date.parse(entry.queriedAt)
  if (Number.isNaN(queriedAt)) return null
  return { balance: BigInt(entry.balance), queriedAt }
}

/**
 * Picks, per voucher, between the method that reads chain state and the one
 * that does not. The unchecked method is used only while the cached state is
 * younger than `maxAgeMs` and shows no dispute, and even then a voucher above
 * the cached balance is rejected. Verifications are serialized here because
 * each underlying method only serializes its own calls.
 */
export function withCachedChannelStateCheck(params: {
  checked: Method.AnyServer
  unchecked: Method.AnyServer
  store: { get(key: string): Promise<unknown> }
  channel: string
  maxAgeMs: number
}): Method.AnyServer {
  const { checked, unchecked, store, channel, maxAgeMs } = params
  let lock: Promise<unknown> = Promise.resolve()

  async function verifyOnce(parameters: VerifyParameters) {
    const payload = parameters.credential.payload
    const action = payload?.action ?? 'voucher'
    const amount = payload?.amount
    if (action !== 'open' && typeof amount === 'string' && /^\d+$/.test(amount)) {
      const cached = await readUndisputedCachedState(store, channel)
      if (cached && Date.now() - cached.queriedAt < maxAgeMs) {
        if (BigInt(amount) > cached.balance) {
          throw new Error(
            `[stellar:channel] Commitment ${amount} exceeds channel balance ${cached.balance}.`,
          )
        }
        return unchecked.verify(parameters)
      }
    }
    return checked.verify(parameters)
  }

  return {
    ...checked,
    async verify(parameters: VerifyParameters) {
      const run = lock.then(
        () => verifyOnce(parameters),
        () => verifyOnce(parameters),
      )
      lock = run.catch(() => undefined)
      return run
    },
  } as Method.AnyServer
}
