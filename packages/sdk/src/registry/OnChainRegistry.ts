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

  async listProviders(): Promise<OnChainProviderInfo[]> {
    const results: OnChainProviderInfo[] = []

    for (const accountId of this.knownAccounts) {
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), this.timeoutMs)

        const account = await this.horizon.loadAccount(accountId)
        clearTimeout(timer)

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
      } catch {
        // skip accounts that fail to load — they may not exist yet
      }
    }

    return results
  }
}
