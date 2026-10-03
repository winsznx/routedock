/**
 * Unit tests for the per-voucher 402 challenge guard (#387).
 *
 * The provider authors the challenge, and @stellar/mpp signs whatever
 * cumulative amount it carries, so without a guard a single voucher can commit
 * the whole channel deposit. These tests script the challenges a provider
 * returns and assert on the context handed to createCredential — the one number
 * that decides what the commitment key signs. Before the guard existed, the
 * inflated-cumulative cases here would have signed 1000000 stroops (the whole
 * minimum deposit) for one voucher worth 1000.
 *
 * mppx/client and @stellar/mpp/channel/client are mocked (registered before the
 * client module is imported, like session-stats.test.ts), but `mppx` itself is
 * real — challenges are built and serialized with its own Challenge helpers.
 *
 * Run with: pnpm --filter @routedock/routedock test
 */

import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import { Challenge, Store } from 'mppx'
import type { RouteDockManifest, SessionHandle, SessionOptions } from '../../types.js'
import { RouteDockChannelStateError } from '../../errors.js'

const CHANNEL_CONTRACT = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'
const OTHER_CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC'
const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const SESSION_URL = 'https://provider.test/stream/orderbook'
/** Same key @stellar/mpp's channel client uses for its client-side baseline. */
const STORE_KEY = `stellar:channel:client:stellar:testnet:${CHANNEL_CONTRACT}:cumulative`

// ── Scripted mppx + channel client ───────────────────────────────────────────

interface ChallengeScript {
  amount?: unknown
  channel?: unknown
  cumulativeAmount?: unknown
}

interface CredentialContext {
  cumulativeAmount?: string
}

type OnChallenge = (
  challenge: Challenge.Challenge,
  helpers: { createCredential: (context?: CredentialContext) => Promise<string> },
) => Promise<string | undefined>

let capturedOnChallenge: OnChallenge | null = null
let capturedChannelOptions: {
  store?: Store.Store
  onProgress?: (event: { type: 'signed'; cumulativeAmount: string }) => void
} | null = null
// Consumed one per fetch, mirroring one challenge per stream() iteration.
let challengeScript: ChallengeScript[] = []
// Contexts the guarded createCredential was handed, in issue order.
let credentialContexts: CredentialContext[] = []
// One entry per createCredential call; an Error makes that call fail.
let credentialErrorScript: Array<Error | undefined> = []

mock.module('@stellar/mpp/channel/client', {
  namedExports: {
    stellar: {
      channel: (opts: {
        store?: Store.Store
        onProgress?: (event: { type: 'signed'; cumulativeAmount: string }) => void
      }) => {
        capturedChannelOptions = opts
        return {}
      },
    },
  },
})

mock.module('mppx/client', {
  namedExports: {
    Mppx: {
      create: (config: { onChallenge?: OnChallenge }) => {
        capturedOnChallenge = config.onChallenge ?? null
        return {
          fetch: async (): Promise<Response> => {
            const script = challengeScript.shift()
            if (!script) throw new Error('no scripted challenge for this fetch')
            if (!capturedOnChallenge) throw new Error('Mppx.create received no onChallenge')
            await capturedOnChallenge(buildChallenge(script), {
              createCredential: async (context) => {
                credentialContexts.push(context ?? {})
                const error = credentialErrorScript.shift()
                if (error) throw error
                // The real channel client signs the context override and then
                // reports it as 'signed' — that feeds the closure's
                // currentCumulative, so mirror it here.
                if (context?.cumulativeAmount !== undefined) {
                  capturedChannelOptions?.onProgress?.({
                    type: 'signed',
                    cumulativeAmount: context.cumulativeAmount,
                  })
                }
                return 'Payment fake-credential'
              },
            })
            return new Response(JSON.stringify({ seq: 1 }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            })
          },
        }
      },
    },
  },
})

const { MppSessionClient } = await import('../MppSessionClient.js')

// ── Fixtures ──────────────────────────────────────────────────────────────────

function buildManifest(): RouteDockManifest {
  return {
    routedock: '1.0',
    name: 'Challenge Guard Test Provider',
    description: 'Provider exercised by session challenge guard unit tests',
    modes: ['mpp-session'],
    network: 'testnet',
    asset: 'USDC',
    asset_contract: ASSET_CONTRACT,
    payee: Keypair.random().publicKey(),
    pricing: {
      'mpp-session': {
        rate: '0.0001',
        per: 'voucher',
        channel_factory: CHANNEL_CONTRACT,
        min_deposit: '0.10',
        refund_waiting_period_ledgers: 17280,
      },
    },
    endpoints: { stream: { method: 'GET', path: '/stream/orderbook' } },
    tags: ['orderbook', 'stellar', 'test'],
  }
}

/** Builds the challenge the provider would have put in WWW-Authenticate. */
function buildChallenge(script: ChallengeScript): Challenge.Challenge {
  return Challenge.from({
    id: 'challenge-guard-test',
    realm: 'provider.test',
    method: 'stellar',
    intent: 'channel',
    request: {
      ...(script.amount !== undefined ? { amount: script.amount } : {}),
      channel: script.channel ?? CHANNEL_CONTRACT,
      ...(script.cumulativeAmount !== undefined
        ? { methodDetails: { cumulativeAmount: script.cumulativeAmount } }
        : {}),
    },
  })
}

function reset(challenges: ChallengeScript[]): void {
  challengeScript = challenges
  credentialContexts = []
  credentialErrorScript = []
}

async function openHandle(options?: SessionOptions): Promise<SessionHandle> {
  const client = new MppSessionClient(Keypair.random(), 'testnet')
  return client.openSession(SESSION_URL, buildManifest(), Keypair.random().secret(), options)
}

/** Advances the stream once, returning the rejection instead of throwing. */
async function nextError(handle: SessionHandle): Promise<unknown> {
  const iter = handle.stream()[Symbol.asyncIterator]()
  try {
    await iter.next()
    return undefined
  } catch (err) {
    return err
  }
}

function isChannelStateError(message: RegExp) {
  return (err: unknown): boolean =>
    err instanceof RouteDockChannelStateError && message.test(err.message)
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MppSessionClient — onChallenge wiring', () => {
  it('passes an onChallenge hook to Mppx.create', async () => {
    capturedOnChallenge = null
    reset([{ amount: '1000', cumulativeAmount: '0' }])
    await openHandle()

    assert.equal(typeof capturedOnChallenge, 'function')
  })
})

describe('MppSessionClient — challenge guard (mpp-session)', () => {
  it('rejects a challenge whose cumulative amount is just under the deposit', async () => {
    // #given the provider's own numbers: rate 1000 stroops, deposit 1,000,000
    reset([{ amount: '1000', cumulativeAmount: '999000' }])
    const handle = await openHandle()

    // #when the first voucher is fetched
    const err = await nextError(handle)

    // #then nothing was signed
    assert.ok(
      isChannelStateError(/cumulative/i)(err),
      `expected a cumulative guard rejection, got ${String(err)}`,
    )
    assert.equal(credentialContexts.length, 0)
  })

  it('rejects a challenge whose amount does not match the manifest rate', async () => {
    reset([{ amount: '5000', cumulativeAmount: '0' }])
    const handle = await openHandle()

    const err = await nextError(handle)

    assert.ok(
      isChannelStateError(/does not match the manifest rate/)(err),
      `expected a rate guard rejection, got ${String(err)}`,
    )
    assert.equal(credentialContexts.length, 0)
  })

  it('rejects a challenge naming a channel other than the manifest channel_factory', async () => {
    reset([{ amount: '1000', channel: OTHER_CONTRACT, cumulativeAmount: '0' }])
    const handle = await openHandle()

    const err = await nextError(handle)

    assert.ok(
      isChannelStateError(/channel_factory/)(err),
      `expected a channel guard rejection, got ${String(err)}`,
    )
    assert.equal(credentialContexts.length, 0)
  })

  it('rejects a non-integer request.amount as a typed error, not a SyntaxError', async () => {
    reset([{ amount: 'abc', cumulativeAmount: '0' }])
    const handle = await openHandle()

    const err = await nextError(handle)

    assert.ok(
      isChannelStateError(/request\.amount is not a base-10 integer string/)(err),
      `expected a typed amount rejection, got ${String(err)}`,
    )
    assert.equal(credentialContexts.length, 0)
  })

  it('rejects a non-integer methodDetails.cumulativeAmount as a typed error', async () => {
    reset([{ amount: '1000', cumulativeAmount: '1.5' }])
    const handle = await openHandle()

    const err = await nextError(handle)

    assert.ok(
      isChannelStateError(/cumulativeAmount is not a base-10 integer string/)(err),
      `expected a typed cumulative rejection, got ${String(err)}`,
    )
    assert.equal(credentialContexts.length, 0)
  })

  it('walks an honest cumulative sequence and keeps stats on the signed values', async () => {
    // #given a provider reporting the cumulative it has already been paid
    reset([
      { amount: '1000', cumulativeAmount: '0' },
      { amount: '1000', cumulativeAmount: '1000' },
      { amount: '1000', cumulativeAmount: '2000' },
    ])
    const handle = await openHandle()
    const iter = handle.stream()[Symbol.asyncIterator]()

    // #when three vouchers are issued
    for (let i = 0; i < 3; i++) {
      await iter.next()
    }

    // #then each signed value is the manifest rate on top of the previous one
    assert.deepEqual(credentialContexts, [
      { cumulativeAmount: '1000' },
      { cumulativeAmount: '2000' },
      { cumulativeAmount: '3000' },
    ])
    assert.equal(handle.stats().currentCumulative, '0.0003000')
  })

  it('ignores a server-reported reset and keeps paying forward', async () => {
    // #given two signed vouchers and a provider that then reports '0'
    reset([
      { amount: '1000', cumulativeAmount: '0' },
      { amount: '1000', cumulativeAmount: '1000' },
      { amount: '1000', cumulativeAmount: '0' },
    ])
    const handle = await openHandle()
    const iter = handle.stream()[Symbol.asyncIterator]()

    // #when the third voucher is issued
    await iter.next()
    await iter.next()
    await iter.next()

    // #then it continues from the locally reserved baseline
    assert.equal(credentialContexts[2]?.cumulativeAmount, '3000')
  })

  it('reserves distinct cumulatives for concurrent vouchers', async () => {
    reset([
      { amount: '1000', cumulativeAmount: '0' },
      { amount: '1000', cumulativeAmount: '0' },
      { amount: '1000', cumulativeAmount: '0' },
      { amount: '1000', cumulativeAmount: '0' },
    ])
    const handle = await openHandle()
    const iter = handle.stream({ concurrency: 2 })[Symbol.asyncIterator]()

    await iter.next()
    await iter.next()

    assert.deepEqual(credentialContexts.slice(0, 2), [
      { cumulativeAmount: '1000' },
      { cumulativeAmount: '2000' },
    ])
  })

  it('rolls the reservation back when credential creation fails', async () => {
    // #given a voucher whose createCredential rejects (e.g. a failed simulation)
    reset([
      { amount: '1000', cumulativeAmount: '0' },
      { amount: '1000', cumulativeAmount: '0' },
    ])
    credentialErrorScript = [new Error('prepare_commitment simulation failed')]
    // One attempt: a failed simulation is retryable at the transport layer, and
    // this test is about the reservation, not the retry loop.
    const client = new MppSessionClient(Keypair.random(), 'testnet', { maxAttempts: 1 })
    const handle = await client.openSession(
      SESSION_URL,
      buildManifest(),
      Keypair.random().secret(),
    )
    // #when the first voucher fails and the stream is retried
    const failed = await handle
      .stream()
      [Symbol.asyncIterator]()
      .next()
      .then(
        () => undefined,
        (err: unknown) => err,
      )
    await handle.stream()[Symbol.asyncIterator]().next()

    // #then the failure surfaces, and the next voucher signs the value the
    // failed one had reserved instead of skipping past it
    assert.match(String(failed), /prepare_commitment simulation failed/)
    assert.deepEqual(credentialContexts, [
      { cumulativeAmount: '1000' },
      { cumulativeAmount: '1000' },
    ])
  })
})

describe('MppSessionClient — challenge guard baseline store', () => {
  it('seeds the baseline from a store entry written by a previous session', async () => {
    // #given a channel that already carries 5000 stroops of signed vouchers
    const store = Store.memory()
    await store.put(STORE_KEY, { amount: '5000' })
    reset([{ amount: '1000', cumulativeAmount: '5000' }])

    // #when a fresh session accepts that challenge
    const handle = await openHandle({ store })
    await handle.stream()[Symbol.asyncIterator]().next()

    // #then it signs on top of the stored baseline, and hands the store to mppx
    assert.deepEqual(credentialContexts, [{ cumulativeAmount: '6000' }])
    assert.equal(capturedChannelOptions?.store, store)
  })

  it('rejects a non-zero baseline when no store is configured', async () => {
    reset([{ amount: '1000', cumulativeAmount: '5000' }])
    const handle = await openHandle()

    const err = await nextError(handle)

    assert.ok(
      isChannelStateError(/store/)(err),
      `expected a store hint in the rejection, got ${String(err)}`,
    )
    assert.ok(/close the channel/.test((err as Error).message))
    assert.equal(credentialContexts.length, 0)
  })

  it('rejects a corrupt stored baseline instead of silently resetting it', async () => {
    const store = Store.memory()
    await store.put(STORE_KEY, { amount: '1.5' })
    reset([{ amount: '1000', cumulativeAmount: '0' }])
    const handle = await openHandle({ store })

    const err = await nextError(handle)

    assert.ok(
      isChannelStateError(/Stored cumulative/)(err),
      `expected a corrupt-store rejection, got ${String(err)}`,
    )
  })

  it('treats an absent stored entry as a zero baseline', async () => {
    const store = Store.memory()
    reset([{ amount: '1000', cumulativeAmount: '0' }])
    const handle = await openHandle({ store })
    await handle.stream()[Symbol.asyncIterator]().next()

    assert.deepEqual(credentialContexts, [{ cumulativeAmount: '1000' }])
  })
})
