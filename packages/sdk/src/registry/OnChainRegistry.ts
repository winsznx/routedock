import { Horizon } from '@stellar/stellar-sdk'

export interface OnChainProviderInfo {
  account: string
  endpoint: string
  tags: string[]
}

function tryDecodeBase64(value: string): string {
  if (
    value.startsWith('http://') ||
    value.startsWith('https://') ||
    value.startsWith('/') ||
    value.startsWith('[')
  ) {
    return value
  }
  try {
    const decoded =
      typeof Buffer !== 'undefined'
        ? Buffer.from(value, 'base64').toString('utf-8')
        : atob(value)
    if (decoded.length > 0 && decoded !== value) return decoded
  } catch {
    // not valid base64 — return as-is
  }
  return value
}

export class OnChainRegistry {
  private readonly horizon: Horizon.Server
  private readonly knownAccounts: string[]
  private readonly timeoutMs: number

  constructor(options: {
    horizonUrl: string
    knownAccounts: string[]
    timeoutMs?: number
  }) {
    this.horizon = new Horizon.Server(options.horizonUrl)
    this.knownAccounts = options.knownAccounts
    this.timeoutMs = options.timeoutMs ?? 10_000
  }

  /**
   * stellar-sdk 14.6.1 has no way to cancel the underlying Horizon request, so
   * we stop waiting on it instead: the promise returned here rejects once
   * `timeoutMs` elapses, even though the request may still be in flight. The
   * timer is always cleared, including on the error path.
   */
  private loadAccountWithTimeout(
    accountId: string,
  ): ReturnType<Horizon.Server['loadAccount']> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Horizon loadAccount timed out after ${this.timeoutMs}ms`)),
        this.timeoutMs,
      )
    })

    return Promise.race([this.horizon.loadAccount(accountId), timeout]).finally(() => {
      if (timer !== undefined) clearTimeout(timer)
    })
  }

  async listProviders(): Promise<OnChainProviderInfo[]> {
    // Load all accounts concurrently so the worst case is one `timeoutMs`, not
    // `knownAccounts.length * timeoutMs`. allSettled preserves input order, so
    // results come back in `knownAccounts` order regardless of completion order.
    const settled = await Promise.allSettled(
      this.knownAccounts.map((accountId) => this.loadAccountWithTimeout(accountId)),
    )

    const results: OnChainProviderInfo[] = []

    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i]!
      // skip accounts that fail to load or time out — they may not exist yet
      if (outcome.status !== 'fulfilled') continue

      const accountId = this.knownAccounts[i]!
      const account = outcome.value

      const dataEntries = account.data_attr as Record<string, string> | undefined
      if (!dataEntries) continue

      const rawEndpoint = dataEntries['routedock_endpoint']
      if (!rawEndpoint) continue

      const endpoint = tryDecodeBase64(rawEndpoint)
      if (!endpoint.startsWith('http://') && !endpoint.startsWith('https://')) continue

      let tags: string[] = []
      const rawTags = dataEntries['routedock_tags']
      if (rawTags) {
        const decoded = tryDecodeBase64(rawTags)
        try {
          const parsed = JSON.parse(decoded)
          if (Array.isArray(parsed)) tags = parsed
        } catch {
          tags = decoded.split(',').map((t) => t.trim()).filter(Boolean)
        }
      }

      results.push({ account: accountId, endpoint, tags })
    }

    return results
  }
}
