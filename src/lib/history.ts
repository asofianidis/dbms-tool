import { createPersistentStore } from './store'

export interface HistoryEntry {
  id: string
  connectionId: string
  connectionName: string
  database: string
  text: string
  at: number
  elapsedMs: number
  ok: boolean
  kind: 'sql' | 'mongo' | 'redis'
}

const LIMIT = 500

export const historyStore = createPersistentStore<HistoryEntry[]>('dbms.history.v1', [])

export function recordHistory(entry: Omit<HistoryEntry, 'id' | 'at'>): void {
  const text = entry.text.trim()
  if (!text) return
  historyStore.set((list) => {
    // Re-running the same text moves it to the top instead of duplicating it
    const rest = list.filter((e) => !(e.text === text && e.connectionId === entry.connectionId))
    return [{ ...entry, text, id: crypto.randomUUID(), at: Date.now() }, ...rest].slice(0, LIMIT)
  })
}
