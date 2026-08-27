/**
 * Unit tests for the mpp-session-ws WebSocket transport (#78).
 *
 * The real stellar.channel() client signs vouchers via a Soroban RPC
 * prepare_commitment call, so this file mocks mppx/client and
 * @stellar/mpp/channel/client (registered before the client module is
 * imported, like hono-orphan-close.test.ts) and scripts the probe / credential
 * / socket lifecycle to exercise the client's orchestration: open channel →
 * negotiate voucher → upgrade HTTP connection to WebSocket → frame streaming.
 *
 * Run with: pnpm --filter @routedock/routedock test
 */

import assert from 'node:assert/strict'
import { describe, it, mock } from 'node:test'
import { Keypair } from '@stellar/stellar-sdk'
import type { RouteDockManifest } from '../../types.js'
import type { WebSocketFactory } from '../MppSessionClient.js'
import {
  RouteDockManifestError,
  RouteDockChannelStateError,
  RouteDockNetworkError,
  RouteDockFacilitatorError,
} from '../../errors.js'

const CHANNEL_CONTRACT = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'
const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const SESSION_URL = 'https://provider.test/stream/orderbook'

// ── Scripted mppx + WebSocket layer ──────────────────────────────────────────

interface MppxScript {
  probeStatus?: number
  probeRejects?: boolean
}

let mppxScript: MppxScript = {}
let wsScript: {
  rejectHandshake?: boolean
  frames?: string[]
  closeCode?: number
} = {}

const fakeMppx = {
  fetch: async (): Promise<Response> => {
    throw new Error('mpp-session-ws stream must not use the SSE fetch path')
  },
  rawFetch: async (): Promise<Response> => {
    if (mppxScript.probeRejects) {
      throw new TypeError('fetch failed')
    }
    return new Response('', { status: mppxScript.probeStatus ?? 402 })
  },
  createCredential: async (): Promise<string> => 'Payment fake-voucher-credential',
}

mock.module('mppx/client', {
  namedExports: {
    Mppx: {
      create: () => fakeMppx,
    },
  },
})

mock.module('@stellar/mpp/channel/client', {
  namedExports: {
    stellar: {
      channel: () => ({}),
    },
  },
})

const { MppSessionClient } = await import('../MppSessionClient.js')

// ── Fixtures ──────────────────────────────────────────────────────────────────

function buildManifest(): RouteDockManifest {
  return {
    routedock: '1.0',
    name: 'WS Session Test Provider',
    description: 'Provider exercised by mpp-session-ws unit tests',
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

function makeFakeWsFactory(): { factory: WebSocketFactory; calls: Array<{ url: string; headers: Record<string, string> }>; closes: Array<number | undefined> } {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  const closes: Array<number | undefined> = []
  const factory: WebSocketFactory = (url, init, handlers) => {
    calls.push({ url, headers: init.headers })
    const socket = {
      readyState: 0, // CONNECTING
      close: (code?: number) => {
        closes.push(code)
        socket.readyState = 3 // CLOSED
      },
    }
    // Deliver the scripted lifecycle asynchronously, like a real handshake.
    queueMicrotask(() => {
      if (wsScript.rejectHandshake) {
        handlers.onError()
        handlers.onClose(1006, 'handshake failed')
        return
      }
      socket.readyState = 1 // OPEN
      handlers.onOpen()
      for (const frame of wsScript.frames ?? []) {
        handlers.onMessage(frame)
      }
      if (wsScript.closeCode !== undefined) {
        socket.readyState = 3
        handlers.onClose(wsScript.closeCode, '')
      }
    })
    return socket
  }
  return { factory, calls, closes }
}

function openWsHandle(wsFactory: WebSocketFactory) {
  const client = new MppSessionClient(Keypair.random(), 'testnet', undefined, wsFactory)
  return client.openSession(SESSION_URL, buildManifest(), Keypair.random().secret(), {
    mode: 'mpp-session-ws',
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('mpp-session-ws — success path', () => {
  it('opens the channel, negotiates the voucher over HTTP, upgrades to WebSocket, and yields frames', async () => {
    mppxScript = {}
    wsScript = { frames: ['{"seq":1,"text":"hello"}', '{"seq":2,"text":"world"}'], closeCode: 1000 }
    const { factory, calls } = makeFakeWsFactory()

    const handle = await openWsHandle(factory)
    const items: unknown[] = []
    for await (const item of handle.stream()) {
      items.push(item)
    }

    // Channel + voucher negotiation went through the HTTP probe (402), and the
    // signed voucher rode the WebSocket handshake as the Authorization header.
    assert.deepEqual(items, [
      { seq: 1, text: 'hello' },
      { seq: 2, text: 'world' },
    ])
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.url, 'wss://provider.test/stream/orderbook')
    assert.equal(calls[0]!.headers.authorization, 'Payment fake-voucher-credential')
  })

  it('converts http:// URLs to ws://', async () => {
    mppxScript = {}
    wsScript = { frames: ['{}'], closeCode: 1000 }
    const { factory, calls } = makeFakeWsFactory()
    const client = new MppSessionClient(Keypair.random(), 'testnet', undefined, factory)
    const handle = await client.openSession(
      'http://provider.test/stream',
      buildManifest(),
      Keypair.random().secret(),
      { mode: 'mpp-session-ws' },
    )
    for await (const _ of handle.stream()) {
      // consume
    }
    assert.equal(calls[0]!.url, 'ws://provider.test/stream')
  })

  it('yields non-JSON frames as raw strings', async () => {
    mppxScript = {}
    wsScript = { frames: ['{"json":true}', 'plain-text-token', '42'], closeCode: 1000 }
    const { factory } = makeFakeWsFactory()

    const handle = await openWsHandle(factory)
    const items: unknown[] = []
    for await (const item of handle.stream()) {
      items.push(item)
    }

    assert.deepEqual(items, [{ json: true }, 'plain-text-token', 42])
  })

  it('ends the stream cleanly when the server closes with code 1000', async () => {
    mppxScript = {}
    wsScript = { frames: ['{"a":1}'], closeCode: 1000 }
    const { factory } = makeFakeWsFactory()

    const handle = await openWsHandle(factory)
    const items: unknown[] = []
    for await (const item of handle.stream()) {
      items.push(item)
    }
    assert.deepEqual(items, [{ a: 1 }])
  })

  it('closes the socket when the consumer stops iterating early', async () => {
    mppxScript = {}
    wsScript = { frames: ['{"a":1}', '{"a":2}', '{"a":3}'] }
    const { factory, closes } = makeFakeWsFactory()

    const handle = await openWsHandle(factory)
    const iter = handle.stream()[Symbol.asyncIterator]()
    const first = await iter.next()
    assert.deepEqual(first.value, { a: 1 })
    await iter.return?.()
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(closes.length, 1, 'socket.close should be called once on early return')
    assert.equal(closes[0], 1000)
  })
})

describe('mpp-session-ws — failure paths', () => {
  it('throws a typed error when the provider responds 200 instead of a 402 challenge', async () => {
    mppxScript = { probeStatus: 200 }
    wsScript = {}
    const { factory } = makeFakeWsFactory()

    const handle = await openWsHandle(factory)
    await assert.rejects(
      async () => {
        for await (const _ of handle.stream()) {
          // consume
        }
      },
      (err: unknown) =>
        err instanceof RouteDockChannelStateError &&
        /expected HTTP 402/.test((err as Error).message),
    )
  })

  it('throws a retryable error when the probe fails with HTTP 503', async () => {
    mppxScript = { probeStatus: 503 }
    wsScript = {}
    const { factory } = makeFakeWsFactory()

    const handle = await openWsHandle(factory)
    await assert.rejects(
      async () => {
        for await (const _ of handle.stream()) {
          // consume
        }
      },
      (err: unknown) =>
        err instanceof RouteDockFacilitatorError && (err as RouteDockFacilitatorError).status === 503,
    )
  })

  it('wraps a probe network failure as RouteDockNetworkError', async () => {
    mppxScript = { probeRejects: true }
    wsScript = {}
    const { factory } = makeFakeWsFactory()

    const handle = await openWsHandle(factory)
    await assert.rejects(
      async () => {
        for await (const _ of handle.stream()) {
          // consume
        }
      },
      (err: unknown) => err instanceof RouteDockNetworkError,
    )
  })

  it('throws when the WebSocket handshake is rejected before upgrade', async () => {
    mppxScript = {}
    wsScript = { rejectHandshake: true }
    const { factory } = makeFakeWsFactory()

    const handle = await openWsHandle(factory)
    await assert.rejects(
      async () => {
        for await (const _ of handle.stream()) {
          // consume
        }
      },
      (err: unknown) =>
        err instanceof RouteDockChannelStateError &&
        /upgrade failed/.test((err as Error).message),
    )
  })

  it('throws when the server closes abnormally mid-stream', async () => {
    mppxScript = {}
    wsScript = { frames: ['{"a":1}'], closeCode: 1011 }
    const { factory } = makeFakeWsFactory()

    const handle = await openWsHandle(factory)
    await assert.rejects(
      async () => {
        for await (const _ of handle.stream()) {
          // consume
        }
      },
      (err: unknown) =>
        err instanceof RouteDockChannelStateError &&
        /abnormally/.test((err as Error).message),
    )
  })
})

describe('mpp-session-ws — session options', () => {
  it('requires pricing for the selected mode', async () => {
    const manifest = buildManifest()
    delete manifest.pricing['mpp-session-ws']
    const client = new MppSessionClient(Keypair.random(), 'testnet', undefined, makeFakeWsFactory().factory)
    await assert.rejects(
      () =>
        client.openSession(SESSION_URL, manifest, Keypair.random().secret(), {
          mode: 'mpp-session-ws',
        }),
      (err: unknown) =>
        err instanceof RouteDockManifestError &&
        /pricing\.mpp-session-ws missing/.test((err as Error).message),
    )
  })

  it('defaults to mpp-session (SSE) when no mode is passed', async () => {
    mppxScript = {}
    const { factory } = makeFakeWsFactory()
    const client = new MppSessionClient(Keypair.random(), 'testnet', undefined, factory)
    // The SSE path must NOT touch the WebSocket factory — it uses mppx.fetch,
    // which the fake rejects loudly. A successful openSession is enough here;
    // the SSE loop itself is covered by stream-backpressure.test.ts.
    const handle = await client.openSession(SESSION_URL, buildManifest(), Keypair.random().secret())
    assert.ok(handle.channelId)
  })
})
