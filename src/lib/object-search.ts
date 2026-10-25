import type { Cell, ObjectKind } from './api'
import type { Dialect } from './engines'
import { literal } from './sql'

/** An object the server found by name, for the command palette. */
export interface SearchHit {
  /** MySQL searches every database at once and says which one each hit is in */
  database: string | null
  schema: string | null
  name: string
  kind: ObjectKind
  /** PostgreSQL routine arguments, which tell overloads apart */
  detail: string | null
}

/** Shortest term worth a round trip; one letter matches most of a catalog. */
export const MIN_SEARCH_LENGTH = 2

/**
 * A LIKE pattern for names containing `term` (or starting with it), lower-cased
 * and with `\` as the escape character. T-SQL also treats `[` as a wildcard.
 */
export function likePattern(dialect: Dialect, term: string, prefix = false): string {
  const special = dialect === 'tsql' ? /[\\%_[]/g : /[\\%_]/g
  const escaped = term
    .trim()
    .toLowerCase()
    .replace(special, (c) => `\\${c}`)
  return prefix ? `${escaped}%` : `%${escaped}%`
}

/**
 * One catalog query returning (db_name, schema_name, object_name, kind, detail)
 * for tables, views, sequences, routines and (MySQL) events whose name contains `term`, prefix
 * matches and short names first.
 */
export function objectSearchSql(dialect: Dialect, term: string, limit = 50): string {
  const pattern = literal(dialect, likePattern(dialect, term))
  const prefix = literal(dialect, likePattern(dialect, term, true))
  // MySQL's default LIKE escape is already a backslash, and ESCAPE '\\' would need doubling
  const escape = dialect === 'mysql' ? '' : ` ESCAPE '\\'`
  const order = (length: string): string =>
    `CASE WHEN lower(object_name) LIKE ${prefix}${escape} THEN 0 ELSE 1 END, ${length}(object_name), object_name`
  switch (dialect) {
    case 'postgres': {
      const user = "n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'"
      return `SELECT * FROM (
  SELECT NULL::text AS db_name, n.nspname::text AS schema_name, c.relname::text AS object_name,
    CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized_view'
      WHEN 'f' THEN 'foreign_table' WHEN 'S' THEN 'sequence' ELSE 'table' END AS kind,
    NULL::text AS detail
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S') AND NOT c.relispartition AND ${user}
    AND c.relname ILIKE ${pattern}${escape}
  UNION ALL
  SELECT NULL, n.nspname::text, p.proname::text,
    CASE p.prokind WHEN 'p' THEN 'procedure' ELSE 'function' END,
    pg_get_function_identity_arguments(p.oid)
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.prokind IN ('f', 'p') AND ${user} AND p.proname ILIKE ${pattern}${escape}
) o
ORDER BY ${order('length')}
LIMIT ${limit}`
    }
    case 'mysql': {
      const system = "('mysql', 'information_schema', 'performance_schema', 'sys')"
      return `SELECT * FROM (
  SELECT table_schema AS db_name, NULL AS schema_name, table_name AS object_name,
    CASE WHEN table_type LIKE '%VIEW%' THEN 'view' WHEN table_type = 'SEQUENCE' THEN 'sequence'
      ELSE 'table' END AS kind, NULL AS detail
  FROM information_schema.tables
  WHERE table_schema NOT IN ${system} AND lower(table_name) LIKE ${pattern}
  UNION ALL
  SELECT routine_schema, NULL, routine_name,
    CASE routine_type WHEN 'PROCEDURE' THEN 'procedure' WHEN 'PACKAGE' THEN 'package'
      ELSE 'function' END, NULL
  FROM information_schema.routines
  WHERE routine_schema NOT IN ${system} AND lower(routine_name) LIKE ${pattern}
    AND routine_type <> 'PACKAGE BODY'
  UNION ALL
  SELECT event_schema, NULL, event_name, 'event', NULL
  FROM information_schema.events
  WHERE event_schema NOT IN ${system} AND lower(event_name) LIKE ${pattern}
) o
ORDER BY ${order('char_length')}
LIMIT ${limit}`
    }
    case 'tsql':
      return `SELECT TOP (${limit}) * FROM (
  SELECT CAST(NULL AS nvarchar(128)) AS db_name, s.name AS schema_name, o.name AS object_name,
    CASE o.type WHEN 'U' THEN 'table' WHEN 'V' THEN 'view' WHEN 'P' THEN 'procedure'
      WHEN 'SN' THEN 'synonym' WHEN 'SO' THEN 'sequence' ELSE 'function' END AS kind,
    CAST(NULL AS nvarchar(max)) AS detail
  FROM sys.objects o JOIN sys.schemas s ON s.schema_id = o.schema_id
  WHERE o.type IN ('U', 'V', 'P', 'FN', 'IF', 'TF', 'SN', 'SO') AND o.is_ms_shipped = 0
    AND lower(o.name) LIKE ${pattern}${escape}
) o
ORDER BY ${order('len')}`
    case 'sqlite':
      return `SELECT NULL AS db_name, NULL AS schema_name, name AS object_name, type AS kind, NULL AS detail
FROM sqlite_master
WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
  AND lower(name) LIKE ${pattern}${escape}
ORDER BY ${order('length')}
LIMIT ${limit}`
  }
}

const text = (cell: Cell | undefined): string | null => (typeof cell === 'string' ? cell : null)

export function parseSearchRows(rows: Cell[][]): SearchHit[] {
  return rows
    .filter((r) => text(r[2]))
    .map((r) => ({
      database: text(r[0]),
      schema: text(r[1]),
      name: text(r[2])!,
      kind: (text(r[3]) ?? 'table') as ObjectKind,
      detail: text(r[4])
    }))
}
