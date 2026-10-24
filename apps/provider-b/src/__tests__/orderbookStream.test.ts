import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import { startOrderbookStream, type OrderbookStreamSocket } from '../orderbookStream.js'

class FakeSocket implements OrderbookStreamSocket {
  readonly sent: string[] = []
  readonly closes: Array<{ code?: number; reason?: string }> = []

  send(data: string) {
    this.sent.push(data)
  }

  close(code?: number, reason?: string) {
    this.closes.push({ ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) })
  }
}

test('sends a snapshot without waiting for a client frame', async () => {
  const socket = new FakeSocket()
  startOrderbookStream(socket, {
    fetchSnapshot: async () => ({ price: '1.0' }),
    intervalMs: 1000,
    maxTicks: 2,
  })

  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(socket.sent, ['{"price":"1.0"}'])
  assert.equal(socket.closes.length, 0)
})

test('closes once at the tick cap and sends nothing after the cap', async () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'] })
  try {
    const socket = new FakeSocket()
    startOrderbookStream(socket, {
      fetchSnapshot: async () => ({ ok: true }),
      intervalMs: 1000,
      maxTicks: 2,
    })
    await new Promise((resolve) => setImmediate(resolve))
    mock.timers.tick(2000)
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(socket.sent.length, 2)
    assert.deepEqual(socket.closes, [{ code: 1000, reason: 'voucher exhausted' }])
    mock.timers.tick(5000)
    assert.equal(socket.sent.length, 2)
  } finally {
    mock.timers.reset()
  }
})

test('stop prevents later sends and does not close the socket', async () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'] })
  try {
    const socket = new FakeSocket()
    const stop = startOrderbookStream(socket, {
      fetchSnapshot: async () => ({ ok: true }),
      intervalMs: 1000,
      maxTicks: 3,
    })
    await new Promise((resolve) => setImmediate(resolve))
    stop()
    stop()
    mock.timers.tick(5000)
    assert.equal(socket.sent.length, 1)
    assert.deepEqual(socket.closes, [])
  } finally {
    mock.timers.reset()
  }
})

test('failed fetches count toward the cap and send no frame', async () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'] })
  try {
    const socket = new FakeSocket()
    let calls = 0
    startOrderbookStream(socket, {
      fetchSnapshot: async () => {
        calls += 1
        if (calls === 1) throw new Error('Horizon unavailable')
        return { ok: true }
      },
      intervalMs: 1000,
      maxTicks: 2,
    })
    await new Promise((resolve) => setImmediate(resolve))
    mock.timers.tick(1000)
    await new Promise((resolve) => setImmediate(resolve))

    assert.equal(calls, 2)
    assert.equal(socket.sent.length, 1)
    assert.deepEqual(socket.closes, [{ code: 1000, reason: 'voucher exhausted' }])
  } finally {
    mock.timers.reset()
  }
})
