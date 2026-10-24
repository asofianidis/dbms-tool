import { useEffect, useState } from 'react'
import { api, type ConnectionConfig, type DbObject } from '@/lib/api'
import { ENGINES } from '@/lib/engines'
import { MIN_SEARCH_LENGTH, objectSearchSql, parseSearchRows } from '@/lib/object-search'
import { queries, queryClient } from '@/lib/queries'
import { activeTab, connectionsStore, defaultDatabase, statusStore } from '@/lib/workspace'

export interface FoundObject {
  connectionId: string
  database: string
  obj: DbObject
}

/** Wait this long after the last keystroke before asking the servers. */
const DEBOUNCE_MS = 250
/** MongoDB has no catalog query across databases, so it lists this many */
const MONGO_DATABASES = 20

/**
 * Where to search each open connection: every database at once on MySQL, the
 * connection's database (and the active tab's) elsewhere, since PostgreSQL and
 * SQL Server catalogs only cover one database.
 */
function targets(): { connection: ConnectionConfig; database: string }[] {
  const statuses = statusStore.get()
  const tab = activeTab()
  const out: { connection: ConnectionConfig; database: string }[] = []
  for (const connection of connectionsStore.get()) {
    if (statuses[connection.id]?.state !== 'connected') continue
    if (connection.engine === 'mysql' || connection.engine === 'mongo') {
      out.push({ connection, database: '' })
      continue
    }
    const databases = new Set([defaultDatabase(connection.id)])
    if (tab && 'connectionId' in tab && tab.connectionId === connection.id && 'database' in tab)
      if (tab.database) databases.add(tab.database)
    for (const database of databases) out.push({ connection, database })
  }
  return out
}

async function search(
  connection: ConnectionConfig,
  database: string,
  term: string
): Promise<FoundObject[]> {
  if (connection.engine === 'mongo') {
    // Collection lists land in the explorer's cache, so later searches reuse them
    const databases = await queryClient.fetchQuery(queries.databases(connection.id))
    const names = databases.filter((d) => !d.isSystem).slice(0, MONGO_DATABASES)
    const lists = await Promise.all(
      names.map(async (d) => ({
        database: d.name,
        objects: await queryClient.fetchQuery(queries.objects(connection.id, d.name, null))
      }))
    )
    const lower = term.toLowerCase()
    return lists.flatMap(({ database, objects }) =>
      objects
        .filter((obj) => obj.name.toLowerCase().includes(lower))
        .map((obj) => ({ connectionId: connection.id, database, obj }))
    )
  }
  const dialect = ENGINES[connection.engine].dialect
  if (!dialect) return []
  const out = await api.execute(connection.id, '__meta', database, objectSearchSql(dialect, term))
  if (out.error) throw new Error(out.error.message)
  return parseSearchRows(out.results[0]?.rows ?? []).map((hit) => ({
    connectionId: connection.id,
    database: hit.database ?? database,
    obj: {
      schema: hit.schema,
      name: hit.name,
      kind: hit.kind,
      detail: hit.detail,
      comment: null,
      rowEstimate: null
    }
  }))
}

/**
 * Objects whose names contain `term` on every open connection, found with
 * catalog queries rather than whatever the explorer happens to have loaded.
 * A connection that fails to answer is left out.
 */
export function useServerObjects(
  term: string,
  enabled: boolean
): { objects: FoundObject[]; searching: boolean } {
  const [objects, setObjects] = useState<FoundObject[]>([])
  const [searching, setSearching] = useState(false)
  useEffect(() => {
    if (!enabled || term.length < MIN_SEARCH_LENGTH) {
      setObjects([])
      setSearching(false)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      setSearching(true)
      void Promise.allSettled(targets().map((t) => search(t.connection, t.database, term))).then(
        (results) => {
          if (cancelled) return
          setObjects(results.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])))
          setSearching(false)
        }
      )
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [term, enabled])
  return { objects, searching }
}
