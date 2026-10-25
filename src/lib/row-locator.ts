import { api, type Cell, type TableInfo } from './api'
import type { Dialect } from './engines'
import { editStatements, literal, wrapInTransaction, type RowEdit, type TableRef } from './sql'

/**
 * How rows of a PostgreSQL table without a primary key are found again for
 * editing: by a unique key whose columns are all NOT NULL when there is one,
 * else by physical row location (`ctid`). Partitioned tables add `tableoid`,
 * since every partition is its own heap and ctids repeat across them.
 */
export interface RowLocator {
  kind: 'unique' | 'ctid' | 'partition-ctid'
  /** Columns that identify a row, used in place of the primary key */
  columns: string[]
  /** System columns selected ahead of the table's own, hidden from the grid */
  hidden: string[]
  /** The unique index, for `unique` */
  index?: string
}

/** Relation kinds whose rows can be located: tables and partitioned tables. */
const LOCATABLE = new Set(['r', 'p'])

/**
 * The relation kind and the narrowest usable unique key of a PostgreSQL table.
 * A key is usable when it's valid, not partial, has no expressions and all its
 * key columns (INCLUDE columns aside) are NOT NULL.
 */
export function rowLocatorSql(schema: string | null, table: string): string {
  const pg = (v: string): string => literal('postgres', v)
  // Columns: relkind, key columns as a JSON array, index name
  return `SELECT c.relkind::text,
  (SELECT json_agg(a.attname::text ORDER BY k.ord)
   FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
   JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
   WHERE k.ord <= i.indnkeyatts),
  i.indexrelid::regclass::text
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN LATERAL (
  SELECT x.indexrelid, x.indkey, x.indnkeyatts
  FROM pg_index x
  WHERE x.indrelid = c.oid AND x.indisunique AND x.indisvalid
    AND x.indpred IS NULL AND x.indexprs IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM unnest(x.indkey) WITH ORDINALITY AS k(attnum, ord)
      JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
      WHERE k.ord <= x.indnkeyatts AND NOT a.attnotnull)
  ORDER BY x.indnkeyatts, x.indexrelid::regclass::text
  LIMIT 1
) i ON true
WHERE c.relname = ${pg(table)} AND n.nspname = ${pg(schema ?? 'public')}`
}

/** Reads the result of `rowLocatorSql`; null for views, foreign tables and the like. */
export function parseRowLocator(rows: Cell[][]): RowLocator | null {
  const row = rows[0]
  if (!row || typeof row[0] !== 'string' || !LOCATABLE.has(row[0])) return null
  let key: unknown = null
  try {
    key = typeof row[1] === 'string' ? JSON.parse(row[1]) : null
  } catch {
    key = null
  }
  if (Array.isArray(key) && key.length && key.every((k) => typeof k === 'string')) {
    return {
      kind: 'unique',
      columns: key,
      hidden: [],
      index: typeof row[2] === 'string' ? row[2] : undefined
    }
  }
  return row[0] === 'p'
    ? { kind: 'partition-ctid', columns: ['tableoid', 'ctid'], hidden: ['tableoid', 'ctid'] }
    : { kind: 'ctid', columns: ['ctid'], hidden: ['ctid'] }
}

export async function loadRowLocator(
  connectionId: string,
  database: string,
  schema: string | null,
  table: string
): Promise<RowLocator | null> {
  const out = await api.execute(connectionId, '__meta', database, rowLocatorSql(schema, table))
  if (out.error) throw new Error(out.error.message)
  return parseRowLocator(out.results[0]?.rows ?? [])
}

/** Whether rows are found by physical location, which changes on every update. */
export function isPhysical(locator: RowLocator | null | undefined): boolean {
  return locator?.kind === 'ctid' || locator?.kind === 'partition-ctid'
}

/** The table info with the locator's columns standing in for the primary key. */
export function withRowLocator(info: TableInfo, locator: RowLocator | null | undefined): TableInfo {
  return locator && !info.primaryKey.length ? { ...info, primaryKey: locator.columns } : info
}

export const ROW_CHANGED_MESSAGE =
  'Row changed since it was loaded (it was updated, deleted or moved); refresh and retry'

/**
 * Runs an UPDATE or DELETE in a DO block that fails unless it touched exactly
 * one row, so a stale ctid rolls the whole commit back instead of silently
 * changing nothing.
 */
export function expectOneRow(statement: string): string {
  let tag = '$dbms_edit$'
  for (let i = 1; statement.includes(tag); i++) tag = `$dbms_edit${i}$`
  return `DO ${tag}
DECLARE dbms_rows bigint;
BEGIN
  ${statement};
  GET DIAGNOSTICS dbms_rows = ROW_COUNT;
  IF dbms_rows <> 1 THEN
    RAISE EXCEPTION '${ROW_CHANGED_MESSAGE.replace(/'/g, "''")}';
  END IF;
END
${tag}`
}

/**
 * Edit statements for the table, guarding each UPDATE and DELETE when rows
 * are located by ctid. `info` should already carry the locator's key.
 */
export function locatedEditStatements(
  dialect: Dialect,
  ref: TableRef,
  info: TableInfo,
  edits: RowEdit[],
  locator?: RowLocator | null
): string[] {
  const statements = editStatements(dialect, ref, info, edits)
  if (dialect !== 'postgres' || !isPhysical(locator)) return statements
  return statements.map((s) => (/^(UPDATE|DELETE)\b/.test(s) ? expectOneRow(s) : s))
}

/** The commit script for the edits: the statements in one transaction, or '' for none. */
export function locatedEditScript(
  dialect: Dialect,
  ref: TableRef,
  info: TableInfo,
  edits: RowEdit[],
  locator?: RowLocator | null
): string {
  const statements = locatedEditStatements(dialect, ref, info, edits, locator)
  return statements.length ? wrapInTransaction(dialect, statements) : ''
}

/** A short note on how rows are being edited, for the status bar. */
export function rowLocatorNote(locator: RowLocator | null | undefined): string | null {
  switch (locator?.kind) {
    case 'unique':
      return `editing by unique key (${locator.columns.join(', ')})`
    case 'ctid':
      return 'editing by row location (ctid)'
    case 'partition-ctid':
      return 'editing by row location (tableoid, ctid)'
    default:
      return null
  }
}
