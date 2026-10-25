import type { Cell, ColumnInfo, TableInfo } from './api'
import type { Dialect } from './engines'
import { isSpatialType, spatialLiteral } from './pg-extensions-aware'

export function quoteIdent(dialect: Dialect, name: string): string {
  switch (dialect) {
    case 'postgres':
      return /^[a-z_][a-z0-9_]*$/.test(name) && !PG_RESERVED.has(name)
        ? name
        : `"${name.replace(/"/g, '""')}"`
    case 'mysql':
      return `\`${name.replace(/`/g, '``')}\``
    case 'tsql':
      return `[${name.replace(/]/g, ']]')}]`
    case 'sqlite':
      // SQLite folds unquoted names to no case at all, so quoting only matters
      // for unusual characters and keywords
      return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !PG_RESERVED.has(name.toLowerCase())
        ? name
        : `"${name.replace(/"/g, '""')}"`
  }
}

const PG_RESERVED = new Set([
  'all',
  'analyse',
  'analyze',
  'and',
  'any',
  'array',
  'as',
  'asc',
  'asymmetric',
  'both',
  'case',
  'cast',
  'check',
  'collate',
  'column',
  'constraint',
  'create',
  'current_date',
  'current_role',
  'current_time',
  'current_timestamp',
  'current_user',
  'default',
  'deferrable',
  'desc',
  'distinct',
  'do',
  'else',
  'end',
  'except',
  'false',
  'fetch',
  'for',
  'foreign',
  'from',
  'grant',
  'group',
  'having',
  'in',
  'initially',
  'intersect',
  'into',
  'lateral',
  'leading',
  'limit',
  'localtime',
  'localtimestamp',
  'not',
  'null',
  'offset',
  'on',
  'only',
  'or',
  'order',
  'placing',
  'primary',
  'references',
  'returning',
  'select',
  'session_user',
  'some',
  'symmetric',
  'table',
  'then',
  'to',
  'trailing',
  'true',
  'union',
  'unique',
  'user',
  'using',
  'variadic',
  'when',
  'where',
  'window',
  'with'
])

export interface TableRef {
  /** Database (MySQL) or schema (PostgreSQL / SQL Server) */
  schema: string | null
  name: string
}

export function qualified(dialect: Dialect, ref: TableRef): string {
  return ref.schema
    ? `${quoteIdent(dialect, ref.schema)}.${quoteIdent(dialect, ref.name)}`
    : quoteIdent(dialect, ref.name)
}

const NUMERIC_TYPE =
  /^(int|integer|smallint|tinyint|mediumint|bigint|int2|int4|int8|serial|bigserial|smallserial|decimal|numeric|real|float|float4|float8|double|double precision|money|smallmoney|bit|year|oid)\b/i

export function isNumericType(typeName: string): boolean {
  return NUMERIC_TYPE.test(typeName.trim())
}

const BOOL_TYPE = /^(bool|boolean)\b/i

export function literal(dialect: Dialect, value: Cell, dataType = ''): string {
  if (value === null) return 'NULL'
  if (typeof value === 'boolean') {
    return dialect === 'tsql' ? (value ? '1' : '0') : value ? 'TRUE' : 'FALSE'
  }
  if (isNumericType(dataType) && /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(value.trim())) {
    return value.trim()
  }
  if (BOOL_TYPE.test(dataType) && /^(t|f|true|false)$/i.test(value)) {
    return /^t/i.test(value) ? 'TRUE' : 'FALSE'
  }
  if (dialect === 'tsql' && /^0x[0-9a-f]*$/i.test(value) && /binary|image/i.test(dataType)) {
    return value
  }
  if (
    dialect === 'mysql' &&
    /^0x[0-9a-f]*$/i.test(value) &&
    /binary|blob|^vector\b/i.test(dataType)
  ) {
    return value
  }
  // MariaDB vectors can also be typed as a float array: [0.1, 0.2]
  if (
    dialect === 'mysql' &&
    /^vector\b/i.test(dataType) &&
    /^\s*\[[\d\s.,eE+-]*\]\s*$/.test(value)
  ) {
    return `VEC_FromText('${value.trim()}')`
  }
  if (dialect === 'postgres' && /^0x[0-9a-f]*$/i.test(value) && /bytea/i.test(dataType)) {
    return `'\\x${value.slice(2)}'`
  }
  // PostGIS columns take WKT / EWKT / hex EWKB; the column's SRID and type are added
  if (dialect === 'postgres' && isSpatialType(dataType)) return spatialLiteral(value, dataType)
  if (dialect === 'sqlite' && /^0x[0-9a-f]*$/i.test(value) && /blob/i.test(dataType)) {
    return `X'${value.slice(2)}'`
  }
  const escaped =
    dialect === 'mysql'
      ? value.replace(/\\/g, '\\\\').replace(/'/g, "''")
      : value.replace(/'/g, "''")
  const unicode =
    dialect === 'tsql' && (/^(n(var)?char|ntext)\b/i.test(dataType) || /[^\x00-\x7f]/.test(value))
  return `${unicode ? 'N' : ''}'${escaped}'`
}

export interface SelectOptions {
  where?: string
  orderBy?: string
  limit: number
  offset?: number
  /** Columns used for a stable order when paging SQL Server */
  keyColumns?: string[]
  /** Columns to select instead of *, e.g. so MySQL's invisible columns show */
  columns?: string[]
}

export function selectRows(dialect: Dialect, ref: TableRef, opts: SelectOptions): string {
  const table = qualified(dialect, ref)
  const where = opts.where?.trim() ? `\nWHERE ${opts.where.trim()}` : ''
  const order = opts.orderBy?.trim()
  const offset = opts.offset ?? 0
  const list = opts.columns?.length
    ? opts.columns.map((c) => quoteIdent(dialect, c)).join(', ')
    : '*'
  if (dialect === 'tsql') {
    if (!offset && !order) return `SELECT TOP (${opts.limit}) ${list}\nFROM ${table}${where}`
    const orderBy =
      order ||
      (opts.keyColumns?.length
        ? opts.keyColumns.map((c) => quoteIdent(dialect, c)).join(', ')
        : '(SELECT NULL)')
    return `SELECT ${list}\nFROM ${table}${where}\nORDER BY ${orderBy}\nOFFSET ${offset} ROWS FETCH NEXT ${opts.limit} ROWS ONLY`
  }
  return `SELECT ${list}\nFROM ${table}${where}${order ? `\nORDER BY ${order}` : ''}\nLIMIT ${opts.limit}${offset ? ` OFFSET ${offset}` : ''}`
}

export function countRows(dialect: Dialect, ref: TableRef, where?: string): string {
  return `SELECT COUNT(*) FROM ${qualified(dialect, ref)}${where?.trim() ? ` WHERE ${where.trim()}` : ''}`
}

/* ---------- "Script as" generators ---------- */

export function scriptSelect(
  dialect: Dialect,
  ref: TableRef,
  columns: ColumnInfo[],
  limit = 1000
): string {
  const cols = columns.length
    ? columns.map((c) => `  ${quoteIdent(dialect, c.name)}`).join(',\n')
    : '  *'
  const table = qualified(dialect, ref)
  if (dialect === 'tsql') return `SELECT TOP (${limit})\n${cols}\nFROM ${table};`
  return `SELECT\n${cols}\nFROM ${table}\nLIMIT ${limit};`
}

export function scriptInsert(dialect: Dialect, ref: TableRef, columns: ColumnInfo[]): string {
  const cols = columns.filter((c) => !c.isGenerated)
  return `INSERT INTO ${qualified(dialect, ref)} (\n${cols
    .map((c) => `  ${quoteIdent(dialect, c.name)}`)
    .join(',\n')}\n) VALUES (\n${cols.map((c) => `  NULL -- ${c.dataType}`).join(',\n')}\n);`
}

export function scriptUpdate(dialect: Dialect, ref: TableRef, info: TableInfo): string {
  const keys = info.primaryKey.length
    ? info.primaryKey
    : info.columns.slice(0, 1).map((c) => c.name)
  const sets = info.columns
    .filter((c) => !keys.includes(c.name) && !c.isGenerated)
    .map((c) => `  ${quoteIdent(dialect, c.name)} = NULL`)
  return `UPDATE ${qualified(dialect, ref)}\nSET\n${sets.join(',\n')}\nWHERE ${keys
    .map((k) => `${quoteIdent(dialect, k)} = NULL`)
    .join(' AND ')};`
}

export function scriptDelete(dialect: Dialect, ref: TableRef, info: TableInfo): string {
  const keys = info.primaryKey.length
    ? info.primaryKey
    : info.columns.slice(0, 1).map((c) => c.name)
  return `DELETE FROM ${qualified(dialect, ref)}\nWHERE ${keys
    .map((k) => `${quoteIdent(dialect, k)} = NULL`)
    .join(' AND ')};`
}

export function scriptCreateTable(dialect: Dialect, ref: TableRef, info: TableInfo): string {
  const lines = info.columns.map((c) => {
    const parts = [`  ${quoteIdent(dialect, c.name)} ${c.dataType}`]
    if (!c.nullable) parts.push('NOT NULL')
    if (c.default != null) parts.push(`DEFAULT ${c.default}`)
    return parts.join(' ')
  })
  const pk = info.indexes.find((i) => i.primary)
  if (pk) {
    lines.push(
      `  CONSTRAINT ${quoteIdent(dialect, pk.name)} PRIMARY KEY (${pk.columns
        .map((c) => quoteIdent(dialect, c))
        .join(', ')})`
    )
  }
  for (const fk of info.foreignKeys) {
    const target = qualified(dialect, { schema: fk.refSchema, name: fk.refTable })
    let line = `  CONSTRAINT ${quoteIdent(dialect, fk.name)} FOREIGN KEY (${fk.columns
      .map((c) => quoteIdent(dialect, c))
      .join(
        ', '
      )}) REFERENCES ${target} (${fk.refColumns.map((c) => quoteIdent(dialect, c)).join(', ')})`
    if (fk.onDelete && fk.onDelete !== 'NO ACTION') line += ` ON DELETE ${fk.onDelete}`
    if (fk.onUpdate && fk.onUpdate !== 'NO ACTION') line += ` ON UPDATE ${fk.onUpdate}`
    lines.push(line)
  }
  const statements = [`CREATE TABLE ${qualified(dialect, ref)} (\n${lines.join(',\n')}\n);`]
  for (const index of info.indexes) {
    if (index.primary) continue
    if (index.definition) {
      statements.push(`${index.definition};`)
    } else {
      statements.push(
        `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdent(dialect, index.name)} ON ${qualified(
          dialect,
          ref
        )} (${index.columns.map((c) => quoteIdent(dialect, c)).join(', ')});`
      )
    }
  }
  return statements.join('\n\n')
}

/* ---------- Data editing ---------- */

export interface RowEdit {
  kind: 'update' | 'insert' | 'delete'
  /** Original values (update / delete), keyed by column name */
  original?: Record<string, Cell>
  /** New values (update / insert), keyed by column name */
  values?: Record<string, Cell>
}

export function editStatements(
  dialect: Dialect,
  ref: TableRef,
  info: TableInfo,
  edits: RowEdit[]
): string[] {
  const table = qualified(dialect, ref)
  const typeOf = (name: string): string => info.columns.find((c) => c.name === name)?.dataType ?? ''
  const keyColumns = info.primaryKey.length ? info.primaryKey : info.columns.map((c) => c.name)
  const where = (original: Record<string, Cell>): string =>
    keyColumns
      .map((k) =>
        original[k] === null
          ? `${quoteIdent(dialect, k)} IS NULL`
          : `${quoteIdent(dialect, k)} = ${literal(dialect, original[k], typeOf(k))}`
      )
      .join(' AND ')
  return edits.flatMap((edit) => {
    if (edit.kind === 'delete' && edit.original) {
      return [`DELETE FROM ${table} WHERE ${where(edit.original)}`]
    }
    if (edit.kind === 'update' && edit.original && edit.values) {
      const sets = Object.entries(edit.values).map(
        ([k, v]) => `${quoteIdent(dialect, k)} = ${literal(dialect, v, typeOf(k))}`
      )
      return sets.length
        ? [`UPDATE ${table} SET ${sets.join(', ')} WHERE ${where(edit.original)}`]
        : []
    }
    if (edit.kind === 'insert' && edit.values) {
      const entries = Object.entries(edit.values)
      if (!entries.length) {
        return [
          dialect === 'mysql'
            ? `INSERT INTO ${table} () VALUES ()`
            : `INSERT INTO ${table} DEFAULT VALUES`
        ]
      }
      return [
        `INSERT INTO ${table} (${entries.map(([k]) => quoteIdent(dialect, k)).join(', ')}) VALUES (${entries
          .map(([k, v]) => literal(dialect, v, typeOf(k)))
          .join(', ')})`
      ]
    }
    return []
  })
}

export function wrapInTransaction(dialect: Dialect, statements: string[]): string {
  const body = statements.map((s) => `${s};`).join('\n')
  switch (dialect) {
    case 'postgres':
      return `BEGIN;\n${body}\nCOMMIT;`
    case 'mysql':
      return `START TRANSACTION;\n${body}\nCOMMIT;`
    case 'tsql':
      return `SET XACT_ABORT ON;\nBEGIN TRANSACTION;\n${body}\nCOMMIT TRANSACTION;`
    case 'sqlite':
      return `BEGIN;\n${body}\nCOMMIT;`
  }
}

/* ---------- Statement splitting ---------- */

export interface StatementRange {
  from: number
  to: number
  text: string
}

/**
 * Splits a script into statements on `;` (and `GO` lines for T-SQL), skipping
 * strings, quoted identifiers, comments and PostgreSQL dollar-quoted bodies.
 */
export function splitStatements(sql: string, dialect: Dialect): StatementRange[] {
  const out: StatementRange[] = []
  let start = 0
  let i = 0
  const n = sql.length
  const push = (end: number, next: number): void => {
    const raw = sql.slice(start, end)
    const lead = raw.length - raw.trimStart().length
    const text = raw.trim()
    if (text) out.push({ from: start + lead, to: start + lead + text.length, text })
    start = next
  }
  // BEGIN … END blocks in T-SQL procedures contain semicolons; only GO separates batches there.
  // MySQL routine bodies are handled by insideMysqlBody.
  const tsqlBlock =
    dialect === 'tsql' &&
    /\b(create|alter)\s+(or\s+alter\s+)?(proc|procedure|function|trigger|view)\b/i
  while (i < n) {
    const c = sql[i]
    const next = sql[i + 1]
    if (c === '-' && next === '-') {
      while (i < n && sql[i] !== '\n') i++
      continue
    }
    if (c === '#' && dialect === 'mysql') {
      while (i < n && sql[i] !== '\n') i++
      continue
    }
    if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2)
      i = end < 0 ? n : end + 2
      continue
    }
    if (c === "'" || c === '"' || c === '`' || (c === '[' && dialect === 'tsql')) {
      const close = c === '[' ? ']' : c
      i++
      while (i < n) {
        if (sql[i] === '\\' && dialect === 'mysql') {
          i += 2
          continue
        }
        if (sql[i] === close) {
          if (sql[i + 1] === close) {
            i += 2
            continue
          }
          break
        }
        i++
      }
      i++
      continue
    }
    if (c === '$' && dialect === 'postgres') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length)
        i = end < 0 ? n : end + m[0].length
        continue
      }
    }
    if (dialect === 'tsql' && (i === 0 || sql[i - 1] === '\n')) {
      const lineEnd = sql.indexOf('\n', i)
      const line = sql.slice(i, lineEnd < 0 ? n : lineEnd)
      if (/^\s*go(\s+\d+)?\s*(--.*)?$/i.test(line)) {
        push(i, lineEnd < 0 ? n : lineEnd + 1)
        i = lineEnd < 0 ? n : lineEnd + 1
        continue
      }
    }
    if (c === ';') {
      const current = sql.slice(start, i)
      if (!(tsqlBlock && tsqlBlock.test(current)) && !insideMysqlBody(current, dialect)) {
        push(i, i + 1)
      }
    }
    i++
  }
  push(n, n)
  return out
}

/** The statement containing (or immediately before) `pos`. */
export function statementAt(sql: string, dialect: Dialect, pos: number): StatementRange | null {
  const statements = splitStatements(sql, dialect)
  if (!statements.length) return null
  let best: StatementRange | null = null
  for (const s of statements) {
    if (pos >= s.from && pos <= s.to + 1) return s
    if (s.to < pos) best = s
  }
  return best ?? statements[0]
}

/** Line/column (1-based) of a character offset. */
export function lineCol(text: string, offset: number): { line: number; col: number } {
  let line = 1
  let col = 1
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') {
      line++
      col = 1
    } else col++
  }
  return { line, col }
}

export async function formatSql(sql: string, dialect: Dialect): Promise<string> {
  const { format } = await import('sql-formatter')
  return format(sql, {
    language:
      dialect === 'postgres'
        ? 'postgresql'
        : dialect === 'mysql'
          ? 'mysql'
          : dialect === 'sqlite'
            ? 'sqlite'
            : 'transactsql',
    keywordCase: 'upper',
    tabWidth: 2,
    linesBetweenQueries: 1
  })
}

/** `sql` without comments, and with string literals emptied. */
export function stripComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
}

/** Describes statements that deserve a confirmation before running. */
export function dangerousStatements(sql: string, dialect: Dialect): string[] {
  const reasons: string[] = []
  for (const statement of splitStatements(sql, dialect)) {
    const s = stripComments(statement.text).trim()
    // MariaDB: removes old versions of a system-versioned table's rows
    if (/^delete\s+history\b/i.test(s)) reasons.push('DELETE HISTORY')
    else if (/^(with\b[\s\S]*?\)\s*)?delete\b/i.test(s) && !/\bwhere\b/i.test(s))
      reasons.push('DELETE without a WHERE clause')
    else if (/^(with\b[\s\S]*?\)\s*)?update\b/i.test(s) && !/\bwhere\b/i.test(s))
      reasons.push('UPDATE without a WHERE clause')
    else if (
      /^drop\s+(table|database|schema|view|materialized\s+view|index|function|procedure|collection)\b/i.test(
        s
      )
    ) {
      reasons.push(s.split(/\s+/).slice(0, 3).join(' ').toUpperCase())
    } else if (/^truncate\b/i.test(s)) reasons.push('TRUNCATE')
    else if (/^alter\s+table\b[\s\S]*\bdrop\b/i.test(s)) reasons.push('ALTER TABLE … DROP')
  }
  return [...new Set(reasons)]
}

export function explainSql(
  sql: string,
  dialect: Dialect,
  analyze: boolean,
  babelfish: boolean
): string {
  const body = sql.trim().replace(/;\s*$/, '')
  switch (dialect) {
    case 'postgres':
      return `EXPLAIN (${analyze ? 'ANALYZE, BUFFERS, ' : ''}VERBOSE, FORMAT JSON)\n${body}`
    case 'mysql':
      return analyze ? `EXPLAIN ANALYZE\n${body}` : `EXPLAIN FORMAT=TREE\n${body}`
    case 'tsql':
      if (babelfish) {
        // Babelfish exposes PostgreSQL plans through its own SET options
        const option = analyze ? 'BABELFISH_STATISTICS PROFILE' : 'BABELFISH_SHOWPLAN_ALL'
        return `SET ${option} ON;\nGO\n${body}\nGO\nSET ${option} OFF;`
      }
      return analyze
        ? `SET STATISTICS XML ON;\nGO\n${body}\nGO\nSET STATISTICS XML OFF;`
        : `SET SHOWPLAN_XML ON;\nGO\n${body}\nGO\nSET SHOWPLAN_XML OFF;`
    case 'sqlite':
      // SQLite has no ANALYZE variant of EXPLAIN
      return `EXPLAIN QUERY PLAN\n${body}`
  }
}

/**
 * True while `current` is inside the BEGIN … END body of a MySQL CREATE
 * PROCEDURE/FUNCTION/TRIGGER/EVENT, where semicolons don't end the statement.
 */
function insideMysqlBody(current: string, dialect: Dialect): boolean {
  if (dialect !== 'mysql') return false
  const text = current.replace(/--[^\n]*/g, ' ').replace(/'(?:[^'\\]|\\.|'')*'/g, "''")
  if (!/^\s*create\s+(definer\s*=\s*\S+\s+)?(procedure|function|trigger|event)\b/i.test(text))
    return false
  const begins = (text.match(/\bbegin\b/gi) ?? []).length
  // END IF / END LOOP / END WHILE / END REPEAT / END CASE close other blocks
  const ends = (text.match(/\bend\b(?!\s+(if|loop|while|repeat|case)\b)/gi) ?? []).length
  return begins > ends
}
