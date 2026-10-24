import type { Cell, ColumnMeta } from './api'

/**
 * Ending other sessions from the server tab's Activity list. Keys match the
 * activity queries: an engine, or `babelfish` for Babelfish's TDS endpoint.
 */
export type SessionAction = 'cancel' | 'kill'

/** The activity column that identifies a session (or, for MongoDB, an operation). */
export const SESSION_ID_COLUMN: Record<string, string> = {
  postgres: 'pid',
  mysql: 'id',
  mssql: 'session_id',
  babelfish: 'spid',
  mongo: 'opid',
  redis: 'id'
}

/** The activity column naming the session a row waits on, where the engine reports it. */
export const BLOCKED_BY_COLUMN: Record<string, string> = {
  postgres: 'blocked_by',
  mssql: 'blocked_by',
  babelfish: 'blocked'
}

export function sessionActions(engineKey: string): SessionAction[] {
  switch (engineKey) {
    case 'postgres':
    case 'mysql':
      return ['cancel', 'kill']
    // T-SQL has no "cancel someone else's query"; MongoDB kills operations
    case 'mssql':
    case 'babelfish':
    case 'mongo':
    case 'redis':
      return ['kill']
    default:
      return []
  }
}

/** The SQL that cancels or ends session `id`, or null when `id` isn't a session number. */
export function sessionActionSql(
  engineKey: string,
  action: SessionAction,
  id: Cell
): string | null {
  if (typeof id !== 'string' || !/^\d+$/.test(id.trim())) return null
  const n = id.trim()
  switch (engineKey) {
    case 'postgres':
      return action === 'cancel'
        ? `SELECT pg_cancel_backend(${n})`
        : `SELECT pg_terminate_backend(${n})`
    case 'mysql':
      return action === 'cancel' ? `KILL QUERY ${n}` : `KILL ${n}`
    case 'mssql':
    case 'babelfish':
      return action === 'kill' ? `KILL ${n}` : null
    default:
      return null
  }
}

/** `killOp`'s `op`: a number on a replica set, `"shard:opid"` through mongos. */
export function mongoOpId(id: Cell): number | string | null {
  if (typeof id !== 'string' || !id.trim()) return null
  const s = id.trim()
  return /^\d+$/.test(s) ? Number(s) : s
}

/** Session ids that other sessions are waiting on. */
export function blockingIds(engineKey: string, columns: ColumnMeta[], rows: Cell[][]): Set<string> {
  const col = columns.findIndex((c) => c.name === BLOCKED_BY_COLUMN[engineKey])
  const out = new Set<string>()
  if (col < 0) return out
  for (const row of rows) {
    const v = row[col]
    if (typeof v !== 'string') continue
    for (const id of v.split(/[,\s{}]+/)) if (id && id !== '0') out.add(id)
  }
  return out
}

/** How many rows are waiting on another session. */
export function blockedCount(engineKey: string, columns: ColumnMeta[], rows: Cell[][]): number {
  const col = columns.findIndex((c) => c.name === BLOCKED_BY_COLUMN[engineKey])
  if (col < 0) return 0
  return rows.filter((r) => typeof r[col] === 'string' && !/^[\s0{},]*$/.test(r[col] as string))
    .length
}
