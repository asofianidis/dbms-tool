import type { DbObject } from '@/lib/api'
import {
  COMPARED_KINDS,
  type CompareScope,
  type Snapshot,
  type SnapshotObject
} from '@/lib/compare'
import type { Dialect } from '@/lib/engines'
import { queries, queryClient } from '@/lib/queries'

export interface SideRef {
  connectionId: string
  database: string
  schema: string | null
  table: string | null
}

const KINDS = new Set<string>([...COMPARED_KINDS, 'foreign_table'])

/** Always asks the server again, so a comparison after running a migration sees its effect. */
const fresh = <T extends { queryKey: readonly unknown[] }>(options: T): T & { staleTime: 0 } => ({
  ...options,
  staleTime: 0
})

async function listObjects(
  dialect: Dialect,
  side: SideRef,
  scope: CompareScope,
  schemas: string[]
): Promise<DbObject[]> {
  const { connectionId, database } = side
  const fetch = (schema: string | null): Promise<DbObject[]> =>
    queryClient.fetchQuery(fresh(queries.objects(connectionId, database, schema)))
  if (dialect === 'mysql') return fetch(null)
  if (scope !== 'database') return fetch(side.schema)
  if (dialect === 'postgres') return (await Promise.all(schemas.map(fetch))).flat()
  // SQL Server lists the whole database at once
  const wanted = new Set(schemas)
  return (await fetch(null)).filter((o) => o.schema !== null && wanted.has(o.schema))
}

/** Loads everything a comparison looks at on one side: object lists, table structures and definitions. */
export async function loadSnapshot(
  dialect: Dialect,
  side: SideRef,
  scope: CompareScope,
  onProgress: (done: number, total: number) => void
): Promise<{ snapshot: Snapshot; failed: string[] }> {
  const { connectionId, database } = side
  let schemas: string[] = []
  if (scope === 'database' && dialect !== 'mysql') {
    const list = await queryClient.fetchQuery(fresh(queries.schemas(connectionId, database)))
    schemas = list.filter((s) => !s.isSystem).map((s) => s.name)
  }
  let objects = (await listObjects(dialect, side, scope, schemas)).filter((o) => KINDS.has(o.kind))
  if (scope === 'table') {
    objects = objects.filter(
      (o) => (o.kind === 'table' || o.kind === 'foreign_table') && o.name === side.table
    )
    if (!objects.length) throw new Error(`Table ${side.table} wasn't found in ${database}`)
  }

  const loaded: SnapshotObject[] = []
  const failed: string[] = []
  let next = 0
  let done = 0
  onProgress(0, objects.length)
  const worker = async (): Promise<void> => {
    while (next < objects.length) {
      const o = objects[next++]
      const entry: SnapshotObject = {
        schema: o.schema,
        name: o.name,
        kind: o.kind,
        detail: o.detail
      }
      try {
        if (o.kind === 'table' || o.kind === 'foreign_table') {
          entry.table = await queryClient.fetchQuery(
            fresh(queries.table(connectionId, database, o.schema, o.name))
          )
        } else {
          entry.definition = await queryClient.fetchQuery(
            fresh(queries.definition(connectionId, database, o.schema, o.name, o.kind, o.detail))
          )
        }
      } catch {
        failed.push(o.schema ? `${o.schema}.${o.name}` : o.name)
      }
      loaded.push(entry)
      onProgress(++done, objects.length)
    }
  }
  // A few at a time keeps big databases from flooding the connection
  await Promise.all(Array.from({ length: Math.min(6, objects.length) }, worker))
  return {
    snapshot: {
      database,
      schema: dialect === 'mysql' || scope === 'database' ? null : side.schema,
      schemas,
      objects: loaded
    },
    failed
  }
}
