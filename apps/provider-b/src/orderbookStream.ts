export interface OrderbookStreamSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
}

export interface OrderbookStreamOptions {
  fetchSnapshot: () => Promise<unknown>
  intervalMs: number
  maxTicks: number
}

/**
 * Start the voucher-bounded orderbook stream. Each completed tick consumes
 * one snapshot allowance, including failed fetches, so an upstream outage
 * cannot leave a paid socket open indefinitely.
 */
export function startOrderbookStream(
  socket: OrderbookStreamSocket,
  { fetchSnapshot, intervalMs, maxTicks }: OrderbookStreamOptions,
): () => void {
  let stopped = false
  let ticks = 0
  let timer: ReturnType<typeof setInterval> | undefined

  const finish = () => {
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
    if (!stopped) {
      stopped = true
      socket.close(1000, 'voucher exhausted')
    }
  }

  const tick = async () => {
    if (stopped || ticks >= maxTicks) return
    ticks += 1
    try {
      const snapshot = await fetchSnapshot()
      if (!stopped) socket.send(JSON.stringify(snapshot))
    } catch (error) {
      console.error('[horizon] orderbook ws error:', error)
    }
    if (ticks >= maxTicks) finish()
  }

  if (maxTicks <= 0) {
    finish()
  } else {
    void tick()
    timer = setInterval(() => void tick(), intervalMs)
  }

  return () => {
    if (stopped) return
    stopped = true
    if (timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }
}
