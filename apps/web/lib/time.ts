const listeners = new Set<() => void>()

let now = Date.now()
let intervalId: ReturnType<typeof setInterval> | null = null

export function getNow(): number {
  return now
}

export function subscribeNow(listener: () => void): () => void {
  listeners.add(listener)

  if (listeners.size === 1) {
    now = Date.now()
    intervalId = setInterval(() => {
      now = Date.now()
      listeners.forEach((callback) => callback())
    }, 15_000)
  }

  return () => {
    listeners.delete(listener)

    if (listeners.size === 0 && intervalId !== null) {
      clearInterval(intervalId)
      intervalId = null
    }
  }
}

export function formatRelativeTime(date: string, nowMs: number): string {
  const ageSeconds = Math.max(0, Math.floor((nowMs - new Date(date).getTime()) / 1000))

  if (ageSeconds < 60) return `${ageSeconds}s ago`

  const minutes = Math.floor(ageSeconds / 60)
  if (minutes < 60) return `${minutes}m ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`

  return `${Math.floor(hours / 24)}d ago`
}
