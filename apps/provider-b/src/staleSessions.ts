import type { SupabaseClient } from '@supabase/supabase-js'

export interface FlagStaleOptions {
  supabase: SupabaseClient
  payee: string
  staleAfterMs: number
  now?: Date
}

/** Move old open sessions to closing so the normal reconciler can settle them. */
export async function flagStaleOpenSessions(opts: FlagStaleOptions): Promise<string[]> {
  const cutoff = new Date((opts.now ?? new Date()).getTime() - opts.staleAfterMs).toISOString()
  const { data, error } = await opts.supabase
    .from('sessions')
    .update({ status: 'closing' })
    .eq('status', 'open')
    .eq('payee', opts.payee)
    .lt('updated_at', cutoff)
    .select('channel_id')

  if (error) throw error
  return (data ?? [])
    .map((row) => (row as { channel_id?: string }).channel_id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
}

export function staleAfterMinutes(value: string | undefined): number {
  const minutes = value === undefined ? Number.NaN : Number(value)
  return Number.isFinite(minutes) && minutes > 0 && minutes < 720 ? minutes : 30
}
