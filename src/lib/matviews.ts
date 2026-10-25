import { queryOptions } from '@tanstack/react-query'
import { api, type ResultSet } from './api'
import { literal, qualified, type TableRef } from './sql'

/** What the explorer and table tab need to know about a PostgreSQL materialized view. */
export interface MatviewStatus {
  /** False after CREATE … WITH NO DATA or REFRESH … WITH NO DATA; reading it fails until refreshed */
  populated: boolean
  /** Has a unique index REFRESH … CONCURRENTLY can use: valid, immediate, no WHERE, plain columns */
  concurrentKey: boolean
}

export type RefreshMode = 'normal' | 'concurrently' | 'no-data'

/** Columns: name, populated, has a unique index usable by CONCURRENTLY. */
export function matviewStatusSql(schema: string): string {
  return `SELECT c.relname::text, c.relispopulated,
  EXISTS (SELECT 1 FROM pg_index i
          WHERE i.indrelid = c.oid AND i.indisunique AND i.indimmediate AND i.indisvalid
            AND i.indpred IS NULL AND i.indexprs IS NULL)
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'm' AND n.nspname = ${literal('postgres', schema)}
ORDER BY 1`
}

/** Values arrive as text from the simple protocol ('t' / 'f'), or as booleans. */
const truthy = (cell: unknown): boolean => cell === true || cell === 't' || cell === 'true'

export function parseMatviewStatus(set: ResultSet | undefined): Record<string, MatviewStatus> {
  const out: Record<string, MatviewStatus> = {}
  for (const row of set?.rows ?? []) {
    if (typeof row[0] !== 'string') continue
    out[row[0]] = { populated: truthy(row[1]), concurrentKey: truthy(row[2]) }
  }
  return out
}

/** Status of every materialized view in a schema, keyed by name. */
export function matviewStatusQuery(connectionId: string, database: string, schema: string | null) {
  return queryOptions({
    queryKey: ['conn', connectionId, 'matviews', database, schema],
    queryFn: async () => {
      const out = await api.execute(
        connectionId,
        '__meta',
        database,
        matviewStatusSql(schema ?? 'public')
      )
      if (out.error) throw new Error(out.error.message)
      return parseMatviewStatus(out.results[0])
    }
  })
}

export function refreshMatviewSql(ref: TableRef, mode: RefreshMode): string {
  const name = qualified('postgres', ref)
  return mode === 'concurrently'
    ? `REFRESH MATERIALIZED VIEW CONCURRENTLY ${name};`
    : mode === 'no-data'
      ? `REFRESH MATERIALIZED VIEW ${name} WITH NO DATA;`
      : `REFRESH MATERIALIZED VIEW ${name};`
}

/** Why REFRESH … CONCURRENTLY can't run, or null when it can (or the status isn't known yet). */
export function concurrentRefreshBlocker(status: MatviewStatus | undefined): string | null {
  if (!status) return null
  if (!status.populated)
    return 'Not populated yet: CONCURRENTLY needs existing data to compare against. Use Refresh first.'
  if (!status.concurrentKey)
    return 'Needs a unique index on plain columns with no WHERE clause on the materialized view'
  return null
}

/** Whether a query error is PostgreSQL refusing to read an unpopulated materialized view. */
export function isUnpopulatedError(message: string): boolean {
  return /materialized view .* has not been populated/i.test(message)
}
