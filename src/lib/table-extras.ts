import { api, type Cell, type TableInfo } from './api'
import type { Dialect } from './engines'
import { parseSqliteTable, sqliteIndexWhere, type SqliteTableShape } from './sqlite-schema'
import { literal, qualified } from './sql'

/**
 * Table structure the table designer edits that `describe_table` doesn't
 * report: CHECK, UNIQUE and (PostgreSQL) EXCLUDE constraints and index options. Read with catalog
 * queries over the metadata session.
 */

export interface CheckInfo {
  /** null for an unnamed SQLite constraint */
  name: string | null
  expression: string
}

export interface UniqueInfo {
  name: string | null
  columns: string[]
  /** Index that enforces the constraint, which isn't listed as a plain index */
  index: string | null
}

export interface IndexDetail {
  name: string
  /** Covering (INCLUDE) columns */
  include: string[]
  /** Partial index predicate */
  where: string | null
}

export interface ExclusionInfo {
  name: string
  /** `EXCLUDE USING gist (room WITH =, during WITH &&)`, as pg_get_constraintdef spells it */
  definition: string
  /** Index that enforces the constraint, which isn't listed as a plain index */
  index: string | null
  /** Inherited from the partitioned parent, so it can't be dropped here */
  inherited: boolean
}

export interface TableExtras {
  checks: CheckInfo[]
  uniques: UniqueInfo[]
  indexes: IndexDetail[]
  /** PostgreSQL exclusion constraints */
  exclusions?: ExclusionInfo[]
  /** SQLite only: what a table rebuild has to carry over */
  sqlite: SqliteTableShape | null
}

export const emptyExtras = (): TableExtras => ({
  checks: [],
  uniques: [],
  indexes: [],
  exclusions: [],
  sqlite: null
})

type Query = 'checks' | 'uniques' | 'indexes' | 'exclusions' | 'table'

/** Catalog queries per kind of detail; kinds a dialect doesn't need are missing. */
export function extrasQueries(
  dialect: Dialect,
  schema: string | null,
  table: string
): Partial<Record<Query, string>> {
  switch (dialect) {
    case 'postgres': {
      const rel = `format('%I.%I', ${literal(dialect, schema ?? 'public')}, ${literal(dialect, table)})::regclass`
      return {
        checks: `SELECT conname::text, pg_get_constraintdef(oid, true)
FROM pg_constraint WHERE conrelid = ${rel} AND contype = 'c' ORDER BY conname`,
        uniques: `SELECT con.conname::text,
  array_to_json(ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(n, o)
    JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.o))::text,
  i.relname::text
FROM pg_constraint con LEFT JOIN pg_class i ON i.oid = con.conindid
WHERE con.conrelid = ${rel} AND con.contype = 'u' ORDER BY con.conname`,
        exclusions: `SELECT con.conname::text, pg_get_constraintdef(con.oid, true), i.relname::text,
  con.conparentid <> 0
FROM pg_constraint con LEFT JOIN pg_class i ON i.oid = con.conindid
WHERE con.conrelid = ${rel} AND con.contype = 'x' ORDER BY con.conname`,
        indexes: `SELECT i.relname::text,
  array_to_json(ARRAY(SELECT pg_get_indexdef(ix.indexrelid, k, true)
    FROM generate_series(ix.indnkeyatts + 1, ix.indnatts) k))::text,
  pg_get_expr(ix.indpred, ix.indrelid, true)
FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid
WHERE ix.indrelid = ${rel} AND NOT ix.indisprimary ORDER BY i.relname`
      }
    }
    case 'tsql': {
      const name = qualified(dialect, { schema: schema ?? 'dbo', name: table })
      const object = `OBJECT_ID(${literal(dialect, name, 'nvarchar')})`
      return {
        checks: `SELECT name, definition FROM sys.check_constraints
WHERE parent_object_id = ${object} ORDER BY name`,
        uniques: `SELECT kc.name, c.name, i.name
FROM sys.key_constraints kc
JOIN sys.indexes i ON i.object_id = kc.parent_object_id AND i.index_id = kc.unique_index_id
JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
WHERE kc.parent_object_id = ${object} AND kc.type = 'UQ' AND ic.is_included_column = 0
ORDER BY kc.name, ic.key_ordinal`,
        indexes: `SELECT i.name, c.name, i.filter_definition
FROM sys.indexes i
LEFT JOIN sys.index_columns ic
  ON ic.object_id = i.object_id AND ic.index_id = i.index_id AND ic.is_included_column = 1
LEFT JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
WHERE i.object_id = ${object} AND i.is_primary_key = 0 AND i.name IS NOT NULL
ORDER BY i.name, ic.index_column_id`
      }
    }
    case 'mysql':
      // Unique constraints are unique indexes, and indexes have no INCLUDE or WHERE
      return {
        checks: `SELECT cc.CONSTRAINT_NAME, cc.CHECK_CLAUSE
FROM information_schema.TABLE_CONSTRAINTS tc
JOIN information_schema.CHECK_CONSTRAINTS cc
  ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
WHERE tc.TABLE_SCHEMA = ${literal(dialect, schema ?? '')} AND tc.TABLE_NAME = ${literal(dialect, table)}
  AND tc.CONSTRAINT_TYPE = 'CHECK'
ORDER BY cc.CONSTRAINT_NAME`
      }
    case 'sqlite':
      return {
        table: `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ${literal(dialect, table)}`
      }
  }
}

const str = (cell: Cell | undefined): string | null =>
  cell === null || cell === undefined ? null : String(cell)

const jsonList = (cell: Cell | undefined): string[] => {
  try {
    const value: unknown = JSON.parse(str(cell) ?? '[]')
    return Array.isArray(value) ? value.map(String) : []
  } catch {
    return []
  }
}

/** Strips parentheses wrapping the whole expression: `((a > 0))` → `a > 0`. */
export function unwrapParens(expression: string): string {
  let s = expression.trim()
  while (s.startsWith('(') && s.endsWith(')')) {
    let depth = 0
    let wraps = true
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '(') depth++
      else if (s[i] === ')') depth--
      if (depth === 0 && i < s.length - 1) {
        wraps = false
        break
      }
    }
    if (!wraps) break
    s = s.slice(1, -1).trim()
  }
  return s
}

/** `CHECK ((price > 0)) NOT VALID` → `price > 0` */
export function checkExpression(definition: string): string {
  const body = definition.trim().replace(/^check\s*/i, '')
  let depth = 0
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '(') depth++
    else if (body[i] === ')' && --depth === 0) return unwrapParens(body.slice(0, i + 1))
  }
  return unwrapParens(body)
}

/** Turns query results (rows per query kind) into extras. */
export function parseExtras(
  dialect: Dialect,
  rows: Partial<Record<Query, Cell[][]>>,
  info: TableInfo
): TableExtras {
  const extras = emptyExtras()
  if (dialect === 'sqlite') {
    const sql = str(rows.table?.[0]?.[0])
    if (sql) {
      const shape = parseSqliteTable(sql)
      extras.sqlite = shape
      extras.checks = shape.checks
      // UNIQUE constraints are enforced by sqlite_autoindex_* indexes
      const auto = info.indexes.filter((ix) => /^sqlite_autoindex_/.test(ix.name))
      extras.uniques = shape.uniques.map((u) => ({
        ...u,
        index:
          auto.find((ix) => ix.columns.join('\u0000') === u.columns.join('\u0000'))?.name ?? null
      }))
    }
    extras.indexes = info.indexes.map((ix) => ({
      name: ix.name,
      include: [],
      where: sqliteIndexWhere(ix.definition)
    }))
    return extras
  }

  extras.checks = (rows.checks ?? []).map((r) => ({
    name: str(r[0]),
    expression:
      dialect === 'postgres' ? checkExpression(str(r[1]) ?? '') : unwrapParens(str(r[1]) ?? '')
  }))
  if (dialect === 'postgres') {
    extras.uniques = (rows.uniques ?? []).map((r) => ({
      name: str(r[0]),
      columns: jsonList(r[1]),
      index: str(r[2])
    }))
    extras.indexes = (rows.indexes ?? []).map((r) => ({
      name: str(r[0]) ?? '',
      include: jsonList(r[1]),
      where: str(r[2])
    }))
    extras.exclusions = (rows.exclusions ?? []).map((r) => ({
      name: str(r[0]) ?? '',
      definition: str(r[1]) ?? '',
      index: str(r[2]),
      inherited: str(r[3]) === 't' || str(r[3]) === 'true'
    }))
  } else if (dialect === 'tsql') {
    for (const r of rows.uniques ?? []) {
      const name = str(r[0])
      const existing = extras.uniques.find((u) => u.name === name)
      if (existing) existing.columns.push(str(r[1]) ?? '')
      else extras.uniques.push({ name, columns: [str(r[1]) ?? ''], index: str(r[2]) })
    }
    for (const r of rows.indexes ?? []) {
      const name = str(r[0]) ?? ''
      const included = str(r[1])
      const where = str(r[2])
      let detail = extras.indexes.find((d) => d.name === name)
      if (!detail) {
        detail = { name, include: [], where: where && unwrapParens(where) }
        extras.indexes.push(detail)
      }
      if (included) detail.include.push(included)
    }
  }
  return extras
}

/**
 * Loads the extras for a table. Details an older server can't report (MySQL
 * before 8.0.16 has no CHECK_CONSTRAINTS) are left empty; SQLite fails
 * outright, since rebuilding without its definition would lose constraints.
 */
export async function loadTableExtras(
  connectionId: string,
  database: string,
  dialect: Dialect,
  schema: string | null,
  table: string,
  info: TableInfo
): Promise<TableExtras> {
  const rows: Partial<Record<Query, Cell[][]>> = {}
  for (const [kind, sql] of Object.entries(extrasQueries(dialect, schema, table)) as [
    Query,
    string
  ][]) {
    try {
      const out = await api.execute(connectionId, '__meta', database, sql)
      if (out.error) throw new Error(out.error.message)
      rows[kind] = out.results[0]?.rows ?? []
    } catch (e) {
      if (dialect === 'sqlite') throw e
    }
  }
  return parseExtras(dialect, rows, info)
}
