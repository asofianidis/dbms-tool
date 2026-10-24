import type { Engine } from './api'
import { createPersistentStore } from './store'

/**
 * A named query, runnable on any connection unless tied to one. Folders and
 * tags organize the list; a folder name may nest with `/` (`Reports/Daily`).
 */
export interface SavedQuery {
  id: string
  name: string
  text: string
  kind: 'sql' | 'mongo'
  createdAt: number
  updatedAt: number
  lastRunAt?: number
  folder?: string
  tags?: string[]
  /** Runs on this connection (and database) by default, and is listed with it */
  connectionId?: string | null
  database?: string | null
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
  query: Pick<SavedQuery, 'name' | 'text' | 'kind'> & { id?: string; folder?: string },
  now = Date.now()
): { list: SavedQuery[]; saved: SavedQuery } {
  const existing = query.id ? list.find((q) => q.id === query.id) : undefined
  const folder = query.folder === undefined ? undefined : query.folder || undefined
  const saved: SavedQuery = existing
    ? {
        ...existing,
        name: query.name.trim(),
        text: query.text,
        updatedAt: now,
        ...(query.folder !== undefined ? { folder } : {})
      }
    : {
        id: crypto.randomUUID(),
        name: query.name.trim(),
        text: query.text,
        kind: query.kind,
        createdAt: now,
        updatedAt: now,
        ...(folder ? { folder } : {})
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

/** `Folder/Sub/Name` → folder `Folder/Sub`, name `Name`. */
export function splitFolder(path: string): { folder: string; name: string } {
  const parts = path
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean)
  const name = parts.pop() ?? ''
  return { folder: parts.join('/'), name }
}

/** Tags from `a, b #c`, lower-cased, without `#` or duplicates. */
export function parseTags(text: string): string[] {
  const tags = text
    .split(/[,\s]+/)
    .map((t) => t.replace(/^#/, '').trim().toLowerCase())
    .filter(Boolean)
  return [...new Set(tags)]
}

export function allFolders(list: SavedQuery[]): string[] {
  const folders = new Set<string>()
  for (const q of list) {
    // Parents count as folders too, so they show while empty of direct entries
    const parts = (q.folder ?? '').split('/').filter(Boolean)
    for (let i = 1; i <= parts.length; i++) folders.add(parts.slice(0, i).join('/'))
  }
  return [...folders].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
}

export function allTags(list: SavedQuery[]): string[] {
  return [...new Set(list.flatMap((q) => q.tags ?? []))].sort()
}

/**
 * Whether a query matches a search: words match the name or text, `#tag`
 * requires a tag, and `@folder` a folder (or a folder inside it).
 */
export function matchesSearch(query: SavedQuery, search: string): boolean {
  for (const token of search.trim().toLowerCase().split(/\s+/).filter(Boolean)) {
    if (token.startsWith('#')) {
      const tag = token.slice(1)
      if (tag && !(query.tags ?? []).some((t) => t.startsWith(tag))) return false
    } else if (token.startsWith('@')) {
      const folder = (query.folder ?? '').toLowerCase()
      const want = token.slice(1)
      if (want && folder !== want && !folder.startsWith(`${want}/`)) return false
    } else if (
      !query.name.toLowerCase().includes(token) &&
      !query.text.toLowerCase().includes(token)
    )
      return false
  }
  return true
}

/** Renames a folder and every folder inside it. */
export function renameFolder(list: SavedQuery[], from: string, to: string): SavedQuery[] {
  return list.map((q) => {
    const folder = q.folder ?? ''
    if (folder !== from && !folder.startsWith(`${from}/`)) return q
    const next = (to + folder.slice(from.length)).replace(/^\/+/, '')
    return { ...q, folder: next || undefined }
  })
}
