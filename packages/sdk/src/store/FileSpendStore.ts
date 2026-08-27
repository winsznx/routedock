import fs from 'node:fs/promises'
import path from 'node:path'
import type { DailySpend, SpendStore } from './SpendStore.js'

/**
 * File-backed durable {@link SpendStore}.
 *
 * Persists the daily spend accumulator to a JSON file on disk, preserving
 * cumulative spending totals across process restarts, crashes, and redeploys.
 */
export class FileSpendStore implements SpendStore {
  readonly filePath: string

  constructor(filePath: string) {
    this.filePath = filePath
  }

  async read(): Promise<DailySpend | null> {
    try {
      const data = await fs.readFile(this.filePath, 'utf-8')
      return JSON.parse(data) as DailySpend
    } catch {
      return null
    }
  }

  async write(state: DailySpend): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    await fs.writeFile(this.filePath, JSON.stringify(state, null, 2), 'utf-8')
  }
}
