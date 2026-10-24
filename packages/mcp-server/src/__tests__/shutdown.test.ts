import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { EventEmitter } from 'node:events'
import {
  closeAllSessions,
  setupShutdownHandlers,
  type ClosableSession,
} from '../shutdown.js'

describe('closeAllSessions', () => {
  it('returns immediately with zero counts when no sessions are open', async () => {
    // #given
    const openSessions = new Map<string, ClosableSession>()

    // #when
    const summary = await closeAllSessions(openSessions)

    // #then
    assert.strictEqual(summary.closed, 0)
    assert.strictEqual(summary.failed, 0)
    assert.strictEqual(summary.timedOut, 0)
    assert.strictEqual(summary.results.length, 0)
    assert.strictEqual(openSessions.size, 0)
  })

  it('closes all open sessions concurrently and empties the map', async () => {
    // #given
    const openSessions = new Map<string, ClosableSession>()
    let closed1 = false
    let closed2 = false

    openSessions.set('channel-1', {
      close: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        closed1 = true
      },
    })
    openSessions.set('channel-2', {
      close: async () => {
        await new Promise((resolve) => setTimeout(resolve, 15))
        closed2 = true
      },
    })

    // #when
    const summary = await closeAllSessions(openSessions, {
      logInfo: () => {},
    })

    // #then
    assert.strictEqual(summary.closed, 2)
    assert.strictEqual(summary.failed, 0)
    assert.strictEqual(summary.timedOut, 0)
    assert.strictEqual(closed1, true)
    assert.strictEqual(closed2, true)
    assert.strictEqual(openSessions.size, 0)
  })

  it('records error and logs to stderr when a session close rejects', async () => {
    // #given
    const openSessions = new Map<string, ClosableSession>()
    const errorsLogged: string[] = []
    const logError = (msg: string) => {
      errorsLogged.push(msg)
    }

    let closedSuccess = false
    openSessions.set('channel-ok', {
      close: async () => {
        closedSuccess = true
      },
    })
    openSessions.set('channel-fail', {
      close: async () => {
        throw new Error('On-chain close rejected: contract revert')
      },
    })

    // #when
    const summary = await closeAllSessions(openSessions, { logError })

    // #then
    assert.strictEqual(summary.closed, 1)
    assert.strictEqual(summary.failed, 1)
    assert.strictEqual(summary.timedOut, 0)
    assert.strictEqual(closedSuccess, true)
    assert.strictEqual(openSessions.size, 0)

    const failResult = summary.results.find((r) => r.channelId === 'channel-fail')
    assert.ok(failResult)
    assert.strictEqual(failResult.status, 'error')
    assert.match(String(failResult.error), /contract revert/)
    assert.ok(errorsLogged.some((log) => log.includes('channel-fail')))
  })

  it('bounds execution to timeoutMs when a session close hangs', async () => {
    // #given
    const openSessions = new Map<string, ClosableSession>()
    let quickClosed = false

    openSessions.set('channel-quick', {
      close: async () => {
        quickClosed = true
      },
    })
    let unblockHangingPromise: () => void = () => {}
    openSessions.set('channel-hanging', {
      close: () =>
        new Promise<void>((resolve) => {
          unblockHangingPromise = () => resolve()
        }),
    })

    const startTime = Date.now()

    try {
      const summary = await closeAllSessions(openSessions, {
        timeoutMs: 60,
        logError: () => {},
      })

      const duration = Date.now() - startTime

      // #then
      assert.strictEqual(summary.closed, 1)
      assert.strictEqual(summary.failed, 0)
      assert.strictEqual(summary.timedOut, 1)
      assert.strictEqual(quickClosed, true)
      assert.ok(duration < 1000, `Expected duration < 1000ms, was ${duration}ms`)
      assert.strictEqual(openSessions.size, 0)

      const hangingResult = summary.results.find((r) => r.channelId === 'channel-hanging')
      assert.ok(hangingResult)
      assert.strictEqual(hangingResult.status, 'timeout')
    } finally {
      // Settle promise so Node 22 test runner does not detect an orphaned pending promise
      unblockHangingPromise()
      await new Promise((resolve) => setImmediate(resolve))
    }
  })
})

class MockProcess extends EventEmitter {
  exitCode: number | null = null
  exit = (code = 0) => {
    this.exitCode = code
  }
}

describe('setupShutdownHandlers', () => {
  it('runs both close calls before exiting when SIGTERM is received', async () => {
    // #given
    const mockProcess = new MockProcess()
    let exitCode: number | null = null
    mockProcess.exit = (code = 0) => {
      exitCode = code
    }

    const openSessions = new Map<string, ClosableSession>()
    let closeCallCount1 = 0
    let closeCallCount2 = 0

    openSessions.set('channel-a', {
      close: async () => {
        closeCallCount1 += 1
      },
    })
    openSessions.set('channel-b', {
      close: async () => {
        closeCallCount2 += 1
      },
    })

    setupShutdownHandlers({
      openSessions,
      processObj: mockProcess,
      logInfo: () => {},
      onExit: (code) => {
        exitCode = code
      },
    })

    // #when
    mockProcess.emit('SIGTERM')
    // Wait for the async shutdown promise to resolve
    await new Promise((resolve) => setTimeout(resolve, 30))

    // #then
    assert.strictEqual(closeCallCount1, 1)
    assert.strictEqual(closeCallCount2, 1)
    assert.strictEqual(exitCode, 0)
    assert.strictEqual(openSessions.size, 0)
  })

  it('exits with non-zero status code after timeout if a session hangs during SIGTERM', async () => {
    // #given
    const mockProcess = new MockProcess()
    let exitCode: number | null = null
    mockProcess.exit = (code = 0) => {
      exitCode = code
    }

    let unblockHang: () => void = () => {}
    const openSessions = new Map<string, ClosableSession>()
    openSessions.set('channel-hang', {
      close: () =>
        new Promise<void>((resolve) => {
          unblockHang = () => resolve()
        }),
    })

    try {
      setupShutdownHandlers({
        openSessions,
        processObj: mockProcess,
        timeoutMs: 50,
        logInfo: () => {},
        logError: () => {},
        onExit: (code) => {
          exitCode = code
        },
      })

      // #when
      mockProcess.emit('SIGTERM')
      await new Promise((resolve) => setTimeout(resolve, 100))

      // #then
      assert.strictEqual(exitCode, 1)
      assert.strictEqual(openSessions.size, 0)
    } finally {
      // Settle promise so Node 22 test runner does not detect an orphaned pending promise
      unblockHang()
      await new Promise((resolve) => setImmediate(resolve))
    }
  })

  it('is idempotent when multiple signals or shutdown triggers fire', async () => {
    // #given
    const mockProcess = new MockProcess()
    let exitCallCount = 0
    mockProcess.exit = () => {
      exitCallCount += 1
    }

    const openSessions = new Map<string, ClosableSession>()
    let closeCallCount = 0
    openSessions.set('channel-once', {
      close: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
        closeCallCount += 1
      },
    })

    const triggerShutdown = setupShutdownHandlers({
      openSessions,
      processObj: mockProcess,
      logInfo: () => {},
      onExit: () => {
        exitCallCount += 1
      },
    })

    // #when: fire SIGINT, SIGTERM, and manual trigger concurrently
    mockProcess.emit('SIGINT')
    mockProcess.emit('SIGTERM')
    void triggerShutdown('manual')

    await new Promise((resolve) => setTimeout(resolve, 50))

    // #then: close() was only called once
    assert.strictEqual(closeCallCount, 1)
    assert.strictEqual(exitCallCount, 1)
  })

  it('triggers shutdown when transport.onclose fires', async () => {
    // #given
    const mockProcess = new MockProcess()
    mockProcess.exit = () => {}

    const mockTransport: { onclose?: (() => void) | undefined } = {}
    const openSessions = new Map<string, ClosableSession>()
    let closed = false

    openSessions.set('channel-transport', {
      close: async () => {
        closed = true
      },
    })

    let exited = false
    setupShutdownHandlers({
      openSessions,
      transport: mockTransport,
      processObj: mockProcess,
      logInfo: () => {},
      onExit: () => {
        exited = true
      },
    })

    // #when
    assert.ok(typeof mockTransport.onclose === 'function')
    mockTransport.onclose()
    await new Promise((resolve) => setTimeout(resolve, 30))

    // #then
    assert.strictEqual(closed, true)
    assert.strictEqual(exited, true)
  })

  it('triggers shutdown when stdin emits end', async () => {
    // #given
    const mockProcess = new MockProcess()
    mockProcess.exit = () => {}
    const mockStdin = new EventEmitter()

    const openSessions = new Map<string, ClosableSession>()
    let closed = false

    openSessions.set('channel-stdin', {
      close: async () => {
        closed = true
      },
    })

    let exited = false
    setupShutdownHandlers({
      openSessions,
      stdin: mockStdin,
      processObj: mockProcess,
      logInfo: () => {},
      onExit: () => {
        exited = true
      },
    })

    // #when
    mockStdin.emit('end')
    await new Promise((resolve) => setTimeout(resolve, 30))

    // #then
    assert.strictEqual(closed, true)
    assert.strictEqual(exited, true)
  })
})
