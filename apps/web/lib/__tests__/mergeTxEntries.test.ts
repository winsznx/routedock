import { describe, it, expect } from 'vitest'
import { mergeTxEntries } from '../mergeTxEntries'
import type { TxLogEntry } from '../supabase'

// Minimal tx_log factory — only the fields a feed renders
function entry(
  overrides: Partial<TxLogEntry> & { id: string; created_at: string },
): TxLogEntry {
  return {
    session_id: null,
    tx_type: 'mpp_charge',
    tx_hash: null,
    amount: 0,
    mode: 'mpp-charge',
    network: 'testnet',
    provider_url: null,
    agent_address: null,
    metadata: null,
    ...overrides,
  }
}

describe('mergeTxEntries', () => {
  it('returns [] for two empty inputs', () => {
    expect(mergeTxEntries([], [], 20)).toEqual([])
  })

  it('keeps one row per id and lets the incoming copy win', () => {
    const stale = entry({ id: 'dup', created_at: '2026-09-25T10:00:00.000Z', amount: 1 })
    const fresh = entry({ id: 'dup', created_at: '2026-09-25T10:00:00.000Z', amount: 2 })

    const merged = mergeTxEntries([stale], [fresh], 20)

    expect(merged).toHaveLength(1)
    expect(merged[0]!.amount).toBe(2)
  })

  it('sorts the output newest created_at first', () => {
    const merged = mergeTxEntries(
      [entry({ id: 'old', created_at: '2026-09-25T09:00:00.000Z' })],
      [
        entry({ id: 'new', created_at: '2026-09-25T11:00:00.000Z' }),
        entry({ id: 'mid', created_at: '2026-09-25T10:00:00.000Z' }),
      ],
      20,
    )

    expect(merged.map((e) => e.id)).toEqual(['new', 'mid', 'old'])
  })

  it('caps the output at max, keeping the newest rows', () => {
    const current = Array.from({ length: 5 }, (_, i) =>
      entry({ id: `c${i}`, created_at: `2026-09-25T10:0${i}:00.000Z` }),
    )
    const incoming = Array.from({ length: 5 }, (_, i) =>
      entry({ id: `i${i}`, created_at: `2026-09-25T11:0${i}:00.000Z` }),
    )

    const merged = mergeTxEntries(current, incoming, 3)

    expect(merged).toHaveLength(3)
    expect(merged.map((e) => e.id)).toEqual(['i4', 'i3', 'i2'])
  })

  it('keeps a realtime row that is newer than the whole fetched batch', () => {
    const fetched = Array.from({ length: 20 }, (_, i) =>
      entry({
        id: `f${i}`,
        created_at: `2026-09-25T10:00:${String(i).padStart(2, '0')}.000Z`,
      }),
    )
    const realtime = entry({ id: 'realtime', created_at: '2026-09-25T10:01:00.000Z' })

    const merged = mergeTxEntries(fetched, [realtime], 20)

    expect(merged).toHaveLength(20)
    expect(merged[0]!.id).toBe('realtime')
    // The oldest fetched row drops off the end
    expect(merged.some((e) => e.id === 'f0')).toBe(false)
  })
})
