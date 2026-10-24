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
  mongo: 'opid'
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

/** Who waits on whom: `[waiter, blocker]` pairs read from a `blocked_by` style column. */
export function blockingEdges(
  columns: ColumnMeta[],
  rows: Cell[][],
  idColumn: string,
  blockedByColumn: string
): [string, string][] {
  const idCol = columns.findIndex((c) => c.name === idColumn)
  const byCol = columns.findIndex((c) => c.name === blockedByColumn)
  if (idCol < 0 || byCol < 0) return []
  const seen = new Set<string>()
  const edges: [string, string][] = []
  for (const row of rows) {
    const waiter = row[idCol]
    const by = row[byCol]
    if (typeof waiter !== 'string' || typeof by !== 'string') continue
    for (const blocker of by.split(/[,\s{}]+/)) {
      const key = `${waiter} ${blocker}`
      if (!blocker || blocker === '0' || blocker === waiter || seen.has(key)) continue
      seen.add(key)
      edges.push([waiter, blocker])
    }
  }
  return edges
}

export interface BlockingNode {
  id: string
  /** Sessions waiting on this one */
  children: BlockingNode[]
  /** This session is also somewhere above itself: a deadlock the server hasn't broken yet */
  cycle: boolean
}

/**
 * Blocking chains as a forest: each root holds locks without waiting on anyone,
 * and its children wait on it. A waiter blocked by several sessions shows under each.
 * Sessions that only block each other (a cycle) start a tree from their lowest id.
 */
export function blockingTree(edges: [string, string][]): BlockingNode[] {
  const waiters = new Map<string, string[]>()
  const blocked = new Set<string>()
  const seen = new Set<string>()
  for (const [waiter, blocker] of edges) {
    if (seen.has(`${waiter} ${blocker}`)) continue
    seen.add(`${waiter} ${blocker}`)
    if (!waiters.has(blocker)) waiters.set(blocker, [])
    waiters.get(blocker)!.push(waiter)
    blocked.add(waiter)
  }
  const byId = (a: string, b: string): number => a.localeCompare(b, undefined, { numeric: true })
  const reached = new Set<string>()
  const build = (id: string, path: Set<string>): BlockingNode => {
    reached.add(id)
    if (path.has(id)) return { id, children: [], cycle: true }
    const next = new Set(path).add(id)
    const children = (waiters.get(id) ?? []).sort(byId).map((w) => build(w, next))
    return { id, children, cycle: false }
  }
  const roots = [...waiters.keys()].filter((id) => !blocked.has(id)).sort(byId)
  const forest = roots.map((id) => build(id, new Set()))
  // Whatever no root reaches is part of a cycle
  for (const id of [...waiters.keys()].sort(byId))
    if (!reached.has(id)) forest.push(build(id, new Set()))
  return forest
}
