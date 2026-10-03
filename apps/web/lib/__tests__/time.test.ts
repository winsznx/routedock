import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatRelativeTime, getNow, subscribeNow } from '../time'

afterEach(() => {
  vi.useRealTimers()
})

describe('formatRelativeTime', () => {
  it('#given a fixed now #when the age is under one minute #then it returns the seconds label', () => {
    const now = Date.parse('2026-09-26T00:00:00.000Z')

    expect(formatRelativeTime('2026-09-26T00:00:00.000Z', now)).toBe('0s ago')
    expect(formatRelativeTime('2026-09-25T23:59:59.000Z', now)).toBe('1s ago')
    expect(formatRelativeTime('2026-09-25T23:59:01.000Z', now)).toBe('59s ago')
  })

  it('#given a fixed now #when the age crosses minute, hour, and day thresholds #then it returns the matching unit', () => {
    const now = Date.parse('2026-09-26T00:00:00.000Z')

    expect(formatRelativeTime('2026-09-25T23:59:00.000Z', now)).toBe('1m ago')
    expect(formatRelativeTime('2026-09-25T23:01:00.000Z', now)).toBe('59m ago')
    expect(formatRelativeTime('2026-09-25T23:00:00.000Z', now)).toBe('1h ago')
    expect(formatRelativeTime('2026-09-25T01:00:00.000Z', now)).toBe('23h ago')
    expect(formatRelativeTime('2026-09-25T00:00:00.000Z', now)).toBe('1d ago')
    expect(formatRelativeTime('2026-09-23T00:00:00.000Z', now)).toBe('3d ago')
  })

  it('#given a future timestamp #when the age would be negative #then it clamps to zero seconds', () => {
    const now = Date.parse('2026-09-26T00:00:00.000Z')

    expect(formatRelativeTime('2026-09-26T00:00:05.000Z', now)).toBe('0s ago')
  })
})

describe('subscribeNow', () => {
  it('#given two subscribers #when the timer advances #then they share one tick and the shared clock moves forward', () => {
    vi.useFakeTimers()
    const now = new Date('2026-09-26T00:00:00.000Z')
    vi.setSystemTime(now)

    const calls: number[] = []
    const unsubscribeA = subscribeNow(() => calls.push(getNow()))
    const unsubscribeB = subscribeNow(() => calls.push(getNow()))

    expect(vi.getTimerCount()).toBe(1)
    expect(getNow()).toBe(now.getTime())

    vi.advanceTimersByTime(15_000)

    expect(getNow()).toBe(now.getTime() + 15_000)
    expect(calls.length).toBeGreaterThan(0)

    unsubscribeA()
    unsubscribeB()

    expect(vi.getTimerCount()).toBe(0)
  })
})
