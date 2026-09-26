import type { TxLogEntry } from './supabase'

/**
 * Union two batches of `tx_log` rows by `id` and keep the newest `max` rows.
 *
 * Every path that adds rows to a feed goes through here so a row that arrives
 * from both a REST fetch and a realtime INSERT is not rendered twice (`motion.li`
 * keys on `id`). The `incoming` copy of a duplicate wins, so a realtime row or a
 * refetched batch replaces a stale snapshot entry. Ordering matches the queries
 * the dashboard and landing page use: newest `created_at` first.
 */
export function mergeTxEntries(
  current: TxLogEntry[],
  incoming: TxLogEntry[],
  max: number,
): TxLogEntry[] {
  const byId = new Map<string, TxLogEntry>()
  for (const entry of current) byId.set(entry.id, entry)
  for (const entry of incoming) byId.set(entry.id, entry)

  return Array.from(byId.values())
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, max)
}
