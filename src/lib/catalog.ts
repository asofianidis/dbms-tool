import { api, type Cell } from './api'
import type { Dialect } from './engines'
import { parsePrincipals, principalQueries, type Principal } from './grants'
import { literal, quoteIdent } from './sql'

/**
 * Catalog objects the explorer lists beside tables and routines: user-defined
 * types, extensions and partitions. Read with catalog SQL on the metadata session.
 */
export interface CatalogItem {
  schema: string | null
  name: string
  /**
   * Types: domain | enum | composite | range (PostgreSQL), alias | table_type | clr (SQL Server).
   * Extensions: extension. Partitions: partition | partitioned (a PostgreSQL partition that is
   * itself partitioned) | subpartition (MySQL).
   */
  kind: string
  /** Base type, extension version, partition bound … */
  detail: string | null
  /** A CREATE statement, when the catalog can give one */
  definition: string | null
  comment: string | null
  rowEstimate: number | null
}

const text = (cell: Cell | undefined): string | null => (typeof cell === 'string' ? cell : null)
const count = (cell: Cell | undefined): number | null => {
  const n = Number(text(cell) ?? NaN)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/* ---------- Types ---------- */

/** User-defined types in a PostgreSQL schema or a SQL Server database; null where there are none. */
export function typesSql(dialect: Dialect, schema: string | null): string | null {
  switch (dialect) {
    case 'postgres':
      // Columns: schema, name, kind, base type, comment, definition
      return `SELECT n.nspname::text, t.typname::text,
  CASE t.typtype WHEN 'd' THEN 'domain' WHEN 'e' THEN 'enum' WHEN 'c' THEN 'composite' ELSE 'range' END,
  CASE t.typtype WHEN 'd' THEN format_type(t.typbasetype, t.typtypmod)
    WHEN 'r' THEN (SELECT format_type(r.rngsubtype, NULL) FROM pg_range r WHERE r.rngtypid = t.oid) END,
  obj_description(t.oid, 'pg_type'),
  CASE t.typtype
    WHEN 'e' THEN format('CREATE TYPE %I.%I AS ENUM (%s);', n.nspname, t.typname,
      (SELECT string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder)
       FROM pg_enum e WHERE e.enumtypid = t.oid))
    WHEN 'd' THEN format('CREATE DOMAIN %I.%I AS %s%s%s%s;', n.nspname, t.typname,
      format_type(t.typbasetype, t.typtypmod),
      CASE WHEN t.typdefault IS NOT NULL THEN ' DEFAULT ' || t.typdefault ELSE '' END,
      CASE WHEN t.typnotnull THEN ' NOT NULL' ELSE '' END,
      coalesce((SELECT string_agg(' CONSTRAINT ' || quote_ident(c.conname) || ' ' || pg_get_constraintdef(c.oid), '' ORDER BY c.conname)
                FROM pg_constraint c WHERE c.contypid = t.oid), ''))
    WHEN 'c' THEN format('CREATE TYPE %I.%I AS (%s);', n.nspname, t.typname,
      (SELECT string_agg(quote_ident(a.attname) || ' ' || format_type(a.atttypid, a.atttypmod), ', ' ORDER BY a.attnum)
       FROM pg_attribute a WHERE a.attrelid = t.typrelid AND a.attnum > 0 AND NOT a.attisdropped))
    ELSE format('CREATE TYPE %I.%I AS RANGE (SUBTYPE = %s);', n.nspname, t.typname,
      (SELECT format_type(r.rngsubtype, NULL) FROM pg_range r WHERE r.rngtypid = t.oid))
  END
FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = ${literal(dialect, schema ?? 'public')} AND t.typtype IN ('d', 'e', 'c', 'r')
  -- Every table has a composite row type; only standalone ones were created as types
  AND (t.typtype <> 'c' OR EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = t.typrelid AND c.relkind = 'c'))
  -- Types that belong to an extension
  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = t.oid AND d.deptype = 'e')
ORDER BY 2`
    case 'tsql': {
      const sized = `TYPE_NAME(t.system_type_id) + CASE
      WHEN TYPE_NAME(t.system_type_id) IN ('varchar', 'char', 'varbinary', 'binary')
        THEN '(' + CASE WHEN t.max_length = -1 THEN 'max' ELSE CAST(t.max_length AS varchar(10)) END + ')'
      WHEN TYPE_NAME(t.system_type_id) IN ('nvarchar', 'nchar')
        THEN '(' + CASE WHEN t.max_length = -1 THEN 'max' ELSE CAST(t.max_length / 2 AS varchar(10)) END + ')'
      WHEN TYPE_NAME(t.system_type_id) IN ('decimal', 'numeric')
        THEN '(' + CAST(t.precision AS varchar(10)) + ',' + CAST(t.scale AS varchar(10)) + ')'
      ELSE '' END`
      // Columns: schema, name, kind, base type, nullable
      return `SELECT s.name, t.name,
  CASE WHEN t.is_table_type = 1 THEN 'table_type' WHEN t.is_assembly_type = 1 THEN 'clr' ELSE 'alias' END,
  CASE WHEN t.is_table_type = 0 AND t.is_assembly_type = 0 THEN ${sized} END,
  CAST(t.is_nullable AS int)
FROM sys.types t JOIN sys.schemas s ON s.schema_id = t.schema_id
WHERE t.is_user_defined = 1
ORDER BY s.name, t.name`
    }
    default:
      return null
  }
}

export function parseTypes(dialect: Dialect, rows: Cell[][]): CatalogItem[] {
  return rows.map((r) => {
    const schema = text(r[0])
    const name = text(r[1]) ?? ''
    const kind = text(r[2]) ?? 'type'
    const base = text(r[3])
    let definition: string | null = null
    if (dialect === 'postgres') definition = text(r[5])
    else if (kind === 'alias' && base)
      definition = `CREATE TYPE ${quoteIdent(dialect, schema ?? 'dbo')}.${quoteIdent(dialect, name)} FROM ${base}${text(r[4]) === '0' ? ' NOT NULL' : ''};`
    return {
      schema,
      name,
      kind,
      detail: base,
      definition,
      comment: dialect === 'postgres' ? text(r[4]) : null,
      rowEstimate: null
    }
  })
}

/* ---------- Extensions ---------- */

/** PostgreSQL extensions installed in the database; null elsewhere. */
export function extensionsSql(dialect: Dialect): string | null {
  if (dialect !== 'postgres') return null
  return `SELECT n.nspname::text, e.extname::text, e.extversion, obj_description(e.oid, 'pg_extension')
FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
ORDER BY 2`
}

export function parseExtensions(rows: Cell[][]): CatalogItem[] {
  return rows.map((r) => {
    const schema = text(r[0])
    const name = text(r[1]) ?? ''
    const version = text(r[2])
    return {
      schema,
      name,
      kind: 'extension',
      detail: version,
      definition: `CREATE EXTENSION IF NOT EXISTS ${quoteIdent('postgres', name)}${schema ? ` WITH SCHEMA ${quoteIdent('postgres', schema)}` : ''}${version ? ` VERSION ${literal('postgres', version)}` : ''};`,
      comment: text(r[3]),
      rowEstimate: null
    }
  })
}

/* ---------- Partitions ---------- */

/**
 * Partitions of a table: PostgreSQL child tables (openable like any table) or
 * MySQL partitions (shown for information). `schema` is the database on MySQL.
 */
export function partitionsSql(
  dialect: Dialect,
  schema: string | null,
  table: string
): string | null {
  switch (dialect) {
    case 'postgres': {
      const parent = literal(
        dialect,
        `${quoteIdent(dialect, schema ?? 'public')}.${quoteIdent(dialect, table)}`
      )
      // Columns: schema, name, kind, bound, rows
      return `SELECT n.nspname::text, c.relname::text,
  CASE WHEN c.relkind = 'p' THEN 'partitioned' ELSE 'partition' END,
  pg_get_expr(c.relpartbound, c.oid), c.reltuples::bigint
FROM pg_inherits i
JOIN pg_class c ON c.oid = i.inhrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE i.inhparent = to_regclass(${parent}) AND c.relispartition
ORDER BY 2`
    }
    case 'mysql':
      // Columns: database, name, kind, method and bound, rows, subpartition
      return `SELECT table_schema, partition_name,
  CASE WHEN subpartition_name IS NULL THEN 'partition' ELSE 'subpartition' END,
  concat_ws(' ', partition_method, partition_expression, partition_description), table_rows, subpartition_name
FROM information_schema.partitions
WHERE table_schema = ${literal(dialect, schema ?? '')} AND table_name = ${literal(dialect, table)}
  AND partition_name IS NOT NULL
ORDER BY partition_ordinal_position, subpartition_ordinal_position`
    default:
      return null
  }
}

export function parsePartitions(dialect: Dialect, rows: Cell[][]): CatalogItem[] {
  return rows.map((r) => {
    const sub = dialect === 'mysql' ? text(r[5]) : null
    return {
      schema: text(r[0]),
      name: sub ? `${text(r[1])}.${sub}` : (text(r[1]) ?? ''),
      kind: text(r[2]) ?? 'partition',
      detail: text(r[3]),
      definition: null,
      comment: null,
      rowEstimate: count(r[4])
    }
  })
}

/* ---------- Running them ---------- */

/** Runs the first query that succeeds on the metadata session and returns its rows. */
export async function catalogRows(
  connectionId: string,
  database: string,
  sqls: string[]
): Promise<Cell[][]> {
  let error: Error | null = null
  for (const sql of sqls) {
    const out = await api.execute(connectionId, '__meta', database, sql)
    if (!out.error) return out.results[0]?.rows ?? []
    error = new Error(out.error.message)
  }
  throw error ?? new Error('No catalog query to run')
}

const queryOf = (sql: string | null): string[] => (sql ? [sql] : [])

export interface CatalogQuery<T> {
  queryKey: readonly unknown[]
  queryFn: () => Promise<T[]>
}

/** Explorer queries; keyed under the connection so a refresh reloads them. */
export const catalogQueries = {
  types: (
    id: string,
    dialect: Dialect,
    database: string,
    schema: string | null
  ): CatalogQuery<CatalogItem> => ({
    queryKey: ['conn', id, 'catalog', database, 'types', schema],
    queryFn: async () =>
      parseTypes(dialect, await catalogRows(id, database, queryOf(typesSql(dialect, schema))))
  }),
  extensions: (id: string, dialect: Dialect, database: string): CatalogQuery<CatalogItem> => ({
    queryKey: ['conn', id, 'catalog', database, 'extensions'],
    queryFn: async () =>
      parseExtensions(await catalogRows(id, database, queryOf(extensionsSql(dialect))))
  }),
  partitions: (
    id: string,
    dialect: Dialect,
    database: string,
    schema: string | null,
    table: string
  ): CatalogQuery<CatalogItem> => ({
    queryKey: ['conn', id, 'catalog', database, 'partitions', schema, table],
    queryFn: async () =>
      parsePartitions(
        dialect,
        await catalogRows(id, database, queryOf(partitionsSql(dialect, schema, table)))
      )
  }),
  /** Users and roles: server-wide on PostgreSQL and MySQL, per database on SQL Server */
  principals: (id: string, dialect: Dialect, database: string): CatalogQuery<Principal> => ({
    queryKey: ['conn', id, 'catalog', database, 'principals'],
    queryFn: async () => parsePrincipals(await catalogRows(id, database, principalQueries(dialect)))
  })
}
