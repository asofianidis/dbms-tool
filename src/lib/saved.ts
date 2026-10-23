import type { Engine } from './api'
import { createPersistentStore } from './store'

/** A named query kept independently of any connection, so it can run anywhere. */
export interface SavedQuery {
  id: string
  name: string
  text: string
  kind: 'sql' | 'mongo'
  createdAt: number
  updatedAt: number
  lastRunAt?: number
}

export const savedQueriesStore = createPersistentStore<SavedQuery[]>('dbms.saved.v1', [])

export function queryKindOf(engine: Engine): SavedQuery['kind'] {
  return engine === 'mongo' ? 'mongo' : 'sql'
}

export function findByName(
  list: SavedQuery[],
  name: string,
  kind: SavedQuery['kind']
): SavedQuery | undefined {
  const key = name.trim().toLowerCase()
  return list.find((q) => q.kind === kind && q.name.toLowerCase() === key)
}

/** Adds a query, or replaces the text of the one with the same id. */
export function upsertQuery(
  list: SavedQuery[],
  query: Pick<SavedQuery, 'name' | 'text' | 'kind'> & { id?: string },
  now = Date.now()
): { list: SavedQuery[]; saved: SavedQuery } {
  const existing = query.id ? list.find((q) => q.id === query.id) : undefined
  const saved: SavedQuery = existing
    ? { ...existing, name: query.name.trim(), text: query.text, updatedAt: now }
    : {
        id: crypto.randomUUID(),
        name: query.name.trim(),
        text: query.text,
        kind: query.kind,
        createdAt: now,
        updatedAt: now
      }
  return {
    list: existing ? list.map((q) => (q.id === saved.id ? saved : q)) : [...list, saved],
    saved
  }
}

export function sortQueries(list: SavedQuery[]): SavedQuery[] {
  return [...list].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
}

export function updateSavedQuery(id: string, patch: Partial<Omit<SavedQuery, 'id'>>): void {
  savedQueriesStore.set((list) => list.map((q) => (q.id === id ? { ...q, ...patch } : q)))
}

export function deleteSavedQuery(id: string): void {
  savedQueriesStore.set((list) => list.filter((q) => q.id !== id))
}
