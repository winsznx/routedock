/**
 * Unit tests for voucher retries and spend accounting on the session transport
 * (#712).
 *
 * #386 made pay() sign once and replay the same credential on retry. The
 * session transport used to re-run the whole 402 cycle inside withRetry, so a
 * 5xx after the provider stored voucher N+1 made the client sign N+2 for the
 * same item, while the local spend cap and stats() counted one voucher. These
 * tests script the provider's responses and assert on what the commitment key
 * was asked to sign, what onSpend was charged, and what the retry sent.
 *
 * mppx/client and @stellar/mpp/channel/client are mocked before the client
 * module is imported, like session-challenge-guard.test.ts; `mppx` itself is
 * real, so challenges are built and serialized with its own helpers.
 *
 * Run with: pnpm --filter @routedock/routedock test
 */

import assert from 'node:assert/strict'
import { beforeEach, describe, it, mock } from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import { Challenge } from 'mppx'
import type { RouteDockManifest, SessionHandle, SessionOptions } from '../../types.js'
import type { WebSocketFactory } from '../MppSessionClient.js'
import { RouteDockChannelStateError, RouteDockPolicyRejectError } from '../../errors.js'

const CHANNEL_CONTRACT = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'
const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const SESSION_URL = 'https://provider.test/stream/orderbook'
/** Manifest rate 0.0001 USDC in stroops. */
const RATE_STROOPS = '1000'

// ── Scripted provider ────────────────────────────────────────────────────────

/**
 * One provider response. A 402 carries a channel challenge; `throws` simulates
 * a dropped connection on that request. Unpaid requests consume probeScript
 * (an honest 402 when it is empty) and paid requests consume paidScript (200
 * when it is empty), so a client that re-runs the 402 cycle on retry is always
 * offered a fresh challenge, like a real provider would.
 */
interface ProviderStep {
  status?: number
  amount?: string
  throws?: boolean
}

interface CredentialContext {
  cumulativeAmount?: string
}

type OnChallenge = (
  challenge: Challenge.Challenge,
  helpers: { createCredential: (context?: CredentialContext) => Promise<string> },
) => Promise<string | undefined>

type ProgressEvent = { type: 'signed'; cumulativeAmount: string }

let capturedOnProgress: ((event: ProgressEvent) => void) | null = null
let probeScript: ProviderStep[] = []
let paidScript: ProviderStep[] = []
/** Contexts handed to the commitment key, in signing order. */
let credentialContexts: CredentialContext[] = []
/** Authorization header of every paid request (initial and replayed). */
let paidAuthorizations: Array<string | null> = []
let rawFetchCalls = 0

function buildChallenge(amount: string): Challenge.Challenge {
  return Challenge.from({
    id: 'session-retry-test',
    realm: 'provider.test',
    method: 'stellar',
    intent: 'channel',
    request: {
      amount,
      channel: CHANNEL_CONTRACT,
      methodDetails: { cumulativeAmount: '0' },
    },
  })
}

function nextProbe(): ProviderStep {
  return probeScript.shift() ?? { status: 402 }
}

function nextPaid(): ProviderStep {
  return paidScript.shift() ?? { status: 200 }
}

function respond(step: ProviderStep): Response {
  if (step.throws) throw new TypeError('fetch failed')
  const status = step.status ?? 200
  if (status === 402) {
    return new Response('', {
      status: 402,
      headers: {
        'WWW-Authenticate': Challenge.serialize(buildChallenge(step.amount ?? RATE_STROOPS)),
      },
    })
  }
  if (status === 200) {
    return new Response(JSON.stringify({ seq: 1 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return new Response('', { status })
}

/** The real channel client signs the context and then reports it as 'signed'. */
async function sign(context?: CredentialContext): Promise<string> {
  credentialContexts.push(context ?? {})
  if (context?.cumulativeAmount !== undefined) {
    capturedOnProgress?.({ type: 'signed', cumulativeAmount: context.cumulativeAmount })
  }
  return `Payment voucher-${context?.cumulativeAmount ?? 'none'}`
}

mock.module('@stellar/mpp/channel/client', {
  namedExports: {
    stellar: {
      channel: (opts: { onProgress?: (event: ProgressEvent) => void }) => {
        capturedOnProgress = opts.onProgress ?? null
        return {}
      },
    },
  },
})

mock.module('mppx/client', {
  namedExports: {
    Mppx: {
      create: (config: { onChallenge?: OnChallenge }) => ({
        // Mirrors mppx.fetch: probe, answer a 402 through onChallenge, then
        // send the paid request with the credential it returned.
        fetch: async (): Promise<Response> => {
          const probe = respond(nextProbe())
          if (probe.status !== 402) return probe
          if (!config.onChallenge) throw new Error('Mppx.create received no onChallenge')
          const credential = await config.onChallenge(Challenge.fromResponse(probe), {
            createCredential: sign,
          })
          paidAuthorizations.push(credential ?? null)
          return respond(nextPaid())
        },
        rawFetch: async (_url: string, init?: RequestInit): Promise<Response> => {
          rawFetchCalls++
          const authorization = new Headers(init?.headers).get('Authorization')
          if (authorization === null) return respond(nextProbe())
          paidAuthorizations.push(authorization)
          return respond(nextPaid())
        },
        createCredential: async (_response: Response, context?: CredentialContext) =>
          sign(context),
      }),
    },
  },
})

const { MppSessionClient } = await import('../MppSessionClient.js')

// ── Fixtures ──────────────────────────────────────────────────────────────────

function buildManifest(): RouteDockManifest {
  return {
    routedock: '1.0',
    name: 'Session Retry Test Provider',
    description: 'Provider exercised by session retry unit tests',
    modes: ['mpp-session', 'mpp-session-ws'],
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
      'mpp-session-ws': {
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

/** Stand-in for RouteDockClient's local daily cap: a running total of charges. */
function makeSpendTracker(capVouchers = Infinity) {
  const tracker = {
    calls: 0,
    dailyTotal: 0,
    onSpend: async (amount: string): Promise<void> => {
      if (tracker.calls >= capVouchers) {
        throw new RouteDockPolicyRejectError('local_daily_cap_exceeded')
      }
      tracker.calls++
      tracker.dailyTotal += Number(amount)
    },
  }
  return tracker
}

function openHandle(
  onSpend?: (amount: string) => Promise<void>,
  options?: SessionOptions,
  webSocketFactory?: WebSocketFactory,
): Promise<SessionHandle> {
  const client = new MppSessionClient(
    Keypair.random(),
    'testnet',
    { baseDelayMs: 1 },
    webSocketFactory,
  )
  return client.openSession(
    SESSION_URL,
    buildManifest(),
    Keypair.random().secret(),
    options,
    onSpend,
  )
}

/** Advances the stream once, returning the rejection instead of throwing. */
async function nextError(iter: AsyncIterator<unknown>): Promise<unknown> {
  try {
    await iter.next()
    return undefined
  } catch (err) {
    return err
  }
}

beforeEach(() => {
  probeScript = []
  paidScript = []
  credentialContexts = []
  paidAuthorizations = []
  rawFetchCalls = 0
})

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MppSessionClient: voucher retry (mpp-session)', () => {
  it('signs exactly one cumulative when the paid request returns 503 and the retry succeeds', async () => {
    // #given a provider whose first paid request fails with 503, then succeeds
    paidScript = [{ status: 503 }, { status: 200 }]
    const handle = await openHandle()

    // #when one item is pulled
    const result = await handle.stream()[Symbol.asyncIterator]().next()

    // #then the commitment key signed one cumulative of one rate
    assert.deepEqual(result.value, { seq: 1 })
    assert.deepEqual(credentialContexts, [{ cumulativeAmount: RATE_STROOPS }])
  })

  it('replays the same Authorization header on the retry', async () => {
    // #given a provider whose first paid request fails with 503, then succeeds
    paidScript = [{ status: 503 }, { status: 200 }]
    const handle = await openHandle()

    // #when one item is pulled
    await handle.stream()[Symbol.asyncIterator]().next()

    // #then the retry went out through rawFetch with the original credential
    assert.equal(rawFetchCalls, 1)
    assert.deepEqual(paidAuthorizations, [
      `Payment voucher-${RATE_STROOPS}`,
      `Payment voucher-${RATE_STROOPS}`,
    ])
  })

  it('reports one voucher and one rate in stats() after a retried item', async () => {
    // #given a provider whose first paid request fails with 503, then succeeds
    paidScript = [{ status: 503 }, { status: 200 }]
    const handle = await openHandle()

    // #when one item is pulled
    await handle.stream()[Symbol.asyncIterator]().next()

    // #then stats() agrees with what was signed
    const stats = handle.stats()
    assert.deepEqual(
      { vouchersIssued: stats.vouchersIssued, currentCumulative: stats.currentCumulative },
      { vouchersIssued: 1, currentCumulative: '0.0001000' },
    )
  })

  it('charges onSpend exactly once for a retried item', async () => {
    // #given a spend tracker and a provider that fails the first paid request
    paidScript = [{ status: 503 }, { status: 200 }]
    const spend = makeSpendTracker()
    const handle = await openHandle(spend.onSpend)

    // #when one item is pulled
    await handle.stream()[Symbol.asyncIterator]().next()

    // #then the cap was charged once
    assert.equal(spend.calls, 1)
  })

  it('replays the credential after a dropped connection on the paid request', async () => {
    // #given the paid request's connection drops after the voucher was signed
    paidScript = [{ throws: true }, { status: 200 }]
    const spend = makeSpendTracker()
    const handle = await openHandle(spend.onSpend)

    // #when one item is pulled
    await handle.stream()[Symbol.asyncIterator]().next()

    // #then the retry replays the voucher instead of signing a second one
    assert.deepEqual(
      { signed: credentialContexts.length, charged: spend.calls, replays: rawFetchCalls },
      { signed: 1, charged: 1, replays: 1 },
    )
  })

  it('retries an unpaid probe failure through the full 402 cycle', async () => {
    // #given the probe fails with 503 before any challenge is answered
    probeScript = [{ status: 503 }]
    const spend = makeSpendTracker()
    const handle = await openHandle(spend.onSpend)

    // #when one item is pulled
    await handle.stream()[Symbol.asyncIterator]().next()

    // #then the retry probes again and signs once, without a replay
    assert.deepEqual(
      { signed: credentialContexts.length, charged: spend.calls, replays: rawFetchCalls },
      { signed: 1, charged: 1, replays: 0 },
    )
  })

  it('surfaces a fresh 402 on the replayed voucher as RouteDockChannelStateError', async () => {
    // #given the provider rejects or lost the voucher and answers the replay with a 402
    paidScript = [{ status: 503 }, { status: 402 }]
    const handle = await openHandle()

    // #when one item is pulled
    const err = await nextError(handle.stream()[Symbol.asyncIterator]())

    // #then the client stops instead of signing a higher cumulative
    assert.ok(
      err instanceof RouteDockChannelStateError && /replayed voucher/.test(err.message),
      `expected a replay rejection, got ${String(err)}`,
    )
    assert.deepEqual(credentialContexts, [{ cumulativeAmount: RATE_STROOPS }])
  })
})

describe('MppSessionClient: spend accounting at the point of signing', () => {
  it('does not charge onSpend when the guard rejects the challenge', async () => {
    // #given a challenge that names a different amount than the manifest rate
    probeScript = [{ status: 402, amount: '999999' }]
    const spend = makeSpendTracker()
    const handle = await openHandle(spend.onSpend)

    // #when one item is pulled
    const err = await nextError(handle.stream()[Symbol.asyncIterator]())

    // #then the guard rejects it and the daily total is untouched
    assert.ok(err instanceof RouteDockChannelStateError, `expected a guard rejection, got ${String(err)}`)
    assert.deepEqual({ calls: spend.calls, dailyTotal: spend.dailyTotal }, { calls: 0, dailyTotal: 0 })
  })

  it('throws the cap error mid-stream before the commitment key signs', async () => {
    // #given a cap that allows exactly one voucher
    const spend = makeSpendTracker(1)
    const handle = await openHandle(spend.onSpend)
    const iter = handle.stream()[Symbol.asyncIterator]()
    await iter.next()

    // #when the second voucher is requested
    const err = await nextError(iter)

    // #then the cap error surfaces and only the first cumulative was signed
    assert.ok(
      err instanceof RouteDockPolicyRejectError && err.reason === 'local_daily_cap_exceeded',
      `expected the cap error, got ${String(err)}`,
    )
    assert.deepEqual(credentialContexts, [{ cumulativeAmount: RATE_STROOPS }])
  })

  it('re-uses a cumulative the cap refused once the cap allows it again', async () => {
    // #given a cap that refuses the first attempt only
    let refused = false
    const onSpend = async (): Promise<void> => {
      if (!refused) {
        refused = true
        throw new RouteDockPolicyRejectError('local_daily_cap_exceeded')
      }
    }
    const handle = await openHandle(onSpend)
    const iter = handle.stream()[Symbol.asyncIterator]()
    await nextError(iter)

    // #when a fresh stream pulls the next item
    await handle.stream()[Symbol.asyncIterator]().next()

    // #then the refused reservation was released, so no cumulative is skipped
    assert.deepEqual(credentialContexts, [{ cumulativeAmount: RATE_STROOPS }])
  })

  it('leaves the daily total unchanged when a WebSocket probe returns 500', async () => {
    // #given a WebSocket session whose HTTP probe fails with 500
    probeScript = [{ status: 500 }]
    const spend = makeSpendTracker()
    const factory: WebSocketFactory = () => {
      throw new Error('the socket must not open after a failed probe')
    }
    const handle = await openHandle(
      spend.onSpend,
      { mode: 'mpp-session-ws' },
      factory,
    )

    // #when the stream is started
    const err = await nextError(handle.stream()[Symbol.asyncIterator]())

    // #then nothing was charged or signed
    assert.ok(err instanceof Error, 'expected the probe failure to surface')
    assert.deepEqual(
      { calls: spend.calls, dailyTotal: spend.dailyTotal, signed: credentialContexts.length },
      { calls: 0, dailyTotal: 0, signed: 0 },
    )
  })
})
