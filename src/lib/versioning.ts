/**
 * MariaDB system-versioned (temporal) tables, 10.3+. Such a table keeps every
 * old version of its rows; `FOR SYSTEM_TIME` after the table name reads them,
 * and the row start / end columns (hidden ROW_START / ROW_END unless the table
 * declares its own) tell when each version was current.
 */
import { queryOptions } from '@tanstack/react-query'
import { api, type Cell, type ServerInfo } from './api'
import { tableStatements, type DdlOptions, type TableDraft } from './ddl'
import type { FilterCondition, QueryState } from './filters'
import { mariaDbAtLeast } from './mariadb'
import { literal, qualified, quoteIdent, type TableRef } from './sql'

/** True when the server has system-versioned tables (MariaDB 10.3+). */
export function supportsVersioning(
  info: Pick<ServerInfo, 'product' | 'version'> | null | undefined
): boolean {
  return mariaDbAtLeast(info, 10, 3)
}

export interface Versioning {
  versioned: boolean
  rowStart: string
  rowEnd: string
  /** The table declares its own period columns (`GENERATED ALWAYS AS ROW START`) */
  explicit: boolean
  /** `SELECT *` leaves the period columns out (implicit or INVISIBLE ones) */
  hidden: boolean
}

export const notVersioned: Versioning = {
  versioned: false,
  rowStart: 'ROW_START',
  rowEnd: 'ROW_END',
  explicit: false,
  hidden: true
}

/** The table type and declared period columns of one table. */
export function versioningSql(database: string, table: string): string {
  return `SELECT t.TABLE_TYPE, c.COLUMN_NAME, c.GENERATION_EXPRESSION, c.EXTRA
FROM information_schema.TABLES t
LEFT JOIN information_schema.COLUMNS c
  ON c.TABLE_SCHEMA = t.TABLE_SCHEMA AND c.TABLE_NAME = t.TABLE_NAME
  AND c.GENERATION_EXPRESSION IN ('ROW START', 'ROW END')
WHERE t.TABLE_SCHEMA = ${literal('mysql', database)} AND t.TABLE_NAME = ${literal('mysql', table)}`
}

const str = (cell: Cell | undefined): string =>
  cell === null || cell === undefined ? '' : String(cell)

export function parseVersioning(rows: Cell[][]): Versioning {
  if (!rows.some((r) => str(r[0]).toUpperCase() === 'SYSTEM VERSIONED')) return notVersioned
  const period = (which: string) => rows.find((r) => str(r[2]).toUpperCase() === which)
  const start = period('ROW START')
  const end = period('ROW END')
  if (!start || !end) return { ...notVersioned, versioned: true }
  return {
    versioned: true,
    rowStart: str(start[1]),
    rowEnd: str(end[1]),
    explicit: true,
    hidden: /\binvisible\b/i.test(str(start[3]))
  }
}

export const versioningQuery = (connectionId: string, database: string, table: string) =>
  queryOptions({
    queryKey: ['conn', connectionId, 'versioning', database, table],
    queryFn: async () => {
      const out = await api.execute(
        connectionId,
        '__meta',
        database,
        versioningSql(database, table)
      )
      if (out.error) throw new Error(out.error.message)
      return parseVersioning(out.results[0]?.rows ?? [])
    }
  })

/** Names of the database's system-versioned tables, for the explorer. */
export const versionedTablesQuery = (connectionId: string, database: string) =>
  queryOptions({
    queryKey: ['conn', connectionId, 'versioned-tables', database],
    queryFn: async () => {
      const out = await api.execute(
        connectionId,
        '__meta',
        database,
        `SELECT TABLE_NAME FROM information_schema.TABLES
WHERE TABLE_SCHEMA = ${literal('mysql', database)} AND TABLE_TYPE = 'SYSTEM VERSIONED'`
      )
      if (out.error) throw new Error(out.error.message)
      return (out.results[0]?.rows ?? []).map((r) => str(r[0]))
    }
  })

/* ---------- Reading history ---------- */

export type SystemTime =
  | { kind: 'current' }
  | { kind: 'asOf'; at: string }
  | { kind: 'between'; from: string; to: string }
  | { kind: 'all' }

/**
 * `2024-05-01`, `2024-05-01T10:30` or `2024-05-01 10:30:15.123456` as the
 * full `YYYY-MM-DD hh:mm:ss[.ffffff]` a TIMESTAMP literal needs, or null.
 */
export function normalizeTimestamp(input: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,6})?)?)?$/.exec(
    input.trim()
  )
  if (!m) return null
  const [, y, mo, d, h = '00', mi = '00', s = '00', frac = ''] = m
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31 || +h > 23 || +mi > 59 || +s > 59) return null
  return `${y}-${mo}-${d} ${h}:${mi}:${s}${frac}`
}

/** Why the system time can't be applied yet, or null. */
export function systemTimeProblem(st: SystemTime): string | null {
  if (st.kind === 'asOf' && !normalizeTimestamp(st.at)) return 'Enter a time as YYYY-MM-DD hh:mm:ss'
  if (st.kind === 'between') {
    const from = normalizeTimestamp(st.from)
    const to = normalizeTimestamp(st.to)
    if (!from || !to) return 'Enter both times as YYYY-MM-DD hh:mm:ss'
    if (from > to) return 'The start time is after the end time'
  }
  return null
}

const timestamp = (value: string): string =>
  `TIMESTAMP ${literal('mysql', normalizeTimestamp(value) ?? value.trim())}`

/** The `FOR SYSTEM_TIME` clause that follows the table name; '' for current rows. */
export function systemTimeClause(st: SystemTime): string {
  switch (st.kind) {
    case 'current':
      return ''
    case 'asOf':
      return `FOR SYSTEM_TIME AS OF ${timestamp(st.at)}`
    case 'between':
      return `FOR SYSTEM_TIME BETWEEN ${timestamp(st.from)} AND ${timestamp(st.to)}`
    case 'all':
      return 'FOR SYSTEM_TIME ALL'
  }
}

/** Short label for the toolbar. */
export function describeSystemTime(st: SystemTime): string {
  switch (st.kind) {
    case 'current':
      return 'Current'
    case 'asOf':
      return `As of ${normalizeTimestamp(st.at) ?? st.at}`
    case 'between':
      return `${normalizeTimestamp(st.from) ?? st.from} – ${normalizeTimestamp(st.to) ?? st.to}`
    case 'all':
      return 'All history'
  }
}

/** The period columns a select has to name: the ones `SELECT *` leaves out. */
function periodColumns(v: Versioning): string {
  if (!v.versioned || !v.hidden) return ''
  return `, ${quoteIdent('mysql', v.rowStart)}, ${quoteIdent('mysql', v.rowEnd)}`
}

export interface VersionedSelect {
  where?: string
  orderBy?: string
  limit: number
  offset?: number
  /** Add the row start / end columns */
  periods?: boolean
  /** Columns to select instead of *, e.g. so invisible columns show */
  columns?: string[]
}

/** A page of a versioned table at the given system time (MySQL dialect). */
export function versionedSelect(
  ref: TableRef,
  v: Versioning,
  st: SystemTime,
  opts: VersionedSelect
): string {
  const clause = systemTimeClause(st)
  const from = `${qualified('mysql', ref)}${clause ? ` ${clause}` : ''}`
  const where = opts.where?.trim() ? `\nWHERE ${opts.where.trim()}` : ''
  const order = opts.orderBy?.trim() ? `\nORDER BY ${opts.orderBy.trim()}` : ''
  const offset = opts.offset ? ` OFFSET ${opts.offset}` : ''
  // Hidden period columns only come with `periods`
  const named = opts.columns?.filter((c) => !v.hidden || (c !== v.rowStart && c !== v.rowEnd))
  const list = named?.length ? named.map((c) => quoteIdent('mysql', c)).join(', ') : '*'
  return `SELECT ${list}${opts.periods ? periodColumns(v) : ''}\nFROM ${from}${where}${order}\nLIMIT ${opts.limit}${offset}`
}

export function versionedCount(ref: TableRef, st: SystemTime, where?: string): string {
  const clause = systemTimeClause(st)
  return `SELECT COUNT(*) FROM ${qualified('mysql', ref)}${clause ? ` ${clause}` : ''}${where?.trim() ? ` WHERE ${where.trim()}` : ''}`
}

/**
 * The key rows are edited by. MariaDB appends the row end column to a declared
 * period's primary key, but among current rows the rest of the key is unique.
 */
export function editKey(primaryKey: string[], v: Versioning | undefined): string[] {
  if (!v?.versioned || !v.explicit) return primaryKey
  const key = primaryKey.filter((k) => k !== v.rowEnd)
  return key.length ? key : primaryKey
}

/** The filter and sort that show every version of one row, oldest first. */
export function rowHistoryQuery(
  v: Versioning,
  key: string[],
  values: Cell[],
  condition: (column: string, value: Cell) => FilterCondition
): QueryState {
  return {
    match: 'all',
    conditions: key.map((k, i) => condition(k, values[i])),
    sorts: [{ column: v.rowStart, dir: 'asc' }]
  }
}

/** Removes old row versions; runs through the usual destructive-statement confirmation. */
export function purgeHistoryScript(ref: TableRef, before: string): string {
  const at = normalizeTimestamp(before) ?? before.trim()
  return `-- Permanently deletes the row versions that stopped being current before this time
DELETE HISTORY FROM ${qualified('mysql', ref)} BEFORE SYSTEM_TIME ${literal('mysql', at)};`
}

/** The local time as `YYYY-MM-DD hh:mm:ss`, a starting value for the time fields. */
export function nowTimestamp(date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`
}

/* ---------- Table designer ---------- */

/** The draft's columns that are the table's declared period columns. */
export function periodColumnIds(draft: TableDraft, v: Versioning | null): string[] {
  if (!v?.versioned || !v.explicit) return []
  return draft.columns
    .filter((c) => c.original && [v.rowStart, v.rowEnd].includes(c.original.name))
    .map((c) => c.id)
}

/**
 * The designer's statements with system versioning switched on or off. `was`
 * is the table as loaded (null when creating), `enabled` the toggle. Altering
 * a versioned table needs `system_versioning_alter_history = KEEP` for the
 * session, or MariaDB refuses the ALTER.
 */
export function versionedTableStatements(
  draft: TableDraft,
  options: DdlOptions,
  was: Versioning | null,
  enabled: boolean
): string[] {
  const periods = new Set(periodColumnIds(draft, was))
  // Turning versioning off drops the period columns itself; while on, they can't be dropped
  const base: TableDraft = periods.size
    ? {
        ...draft,
        columns: draft.columns.map((c) => (periods.has(c.id) ? { ...c, dropped: false } : c))
      }
    : draft
  const statements = tableStatements('mysql', base, options)
  if (!draft.original) {
    if (!enabled || !statements.length) return statements
    return [`${statements[0]} WITH SYSTEM VERSIONING`, ...statements.slice(1)]
  }
  const wasVersioned = !!was?.versioned
  if (enabled && !wasVersioned) {
    const table = qualified('mysql', { schema: draft.schema, name: draft.name.trim() })
    return [...statements, `ALTER TABLE ${table} ADD SYSTEM VERSIONING`]
  }
  if (!wasVersioned) return statements
  const keep = 'SET SESSION system_versioning_alter_history = KEEP'
  if (enabled) return statements.length ? [keep, ...statements] : statements
  const table = qualified('mysql', { schema: draft.schema, name: draft.original.name })
  const drop = was.explicit
    ? `ALTER TABLE ${table}\n  DROP SYSTEM VERSIONING,\n  DROP PERIOD FOR SYSTEM_TIME,\n  DROP COLUMN ${quoteIdent('mysql', was.rowStart)},\n  DROP COLUMN ${quoteIdent('mysql', was.rowEnd)}`
    : `ALTER TABLE ${table} DROP SYSTEM VERSIONING`
  return [keep, drop, ...statements]
}

/** Why the draft can't be applied with this versioning, or null. */
export function versioningProblem(
  draft: TableDraft,
  was: Versioning | null,
  enabled: boolean
): string | null {
  if (!enabled || !was) return null
  const dropped = draft.columns.find((c) => c.dropped && periodColumnIds(draft, was).includes(c.id))
  return dropped
    ? `${dropped.original!.name} records when row versions start and end; turn off system versioning to remove it`
    : null
}

/** Warnings about what the versioning change does. */
export function versioningWarnings(
  draft: TableDraft,
  was: Versioning | null,
  enabled: boolean,
  statements: number
): string[] {
  if (!draft.original || !was?.versioned) return []
  if (!enabled)
    return [
      `Turns off system versioning and permanently deletes the table's history${
        was.explicit ? `, including columns ${was.rowStart} and ${was.rowEnd}` : ''
      }`
    ]
  return statements
    ? ['Alters a system-versioned table; its history rows change along with it']
    : []
}
