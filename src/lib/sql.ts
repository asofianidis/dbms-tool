import type { Cell, ColumnInfo, TableInfo } from './api'
import type { Dialect } from './engines'
import { insideMariaDbBlock } from './mariadb-packages'
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
  /** Expressions selected ahead of the columns, e.g. PostgreSQL's ctid for editing without a key */
  leadingColumns?: string[]
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
  const leading = opts.leadingColumns?.length ? `${opts.leadingColumns.join(', ')}, ` : ''
  return `SELECT ${leading}${list}\nFROM ${table}${where}${order ? `\nORDER BY ${order}` : ''}\nLIMIT ${opts.limit}${offset ? ` OFFSET ${offset}` : ''}`
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
    const skip = skipQuoted(sql, i, dialect)
    if (skip >= 0) {
      i = skip
      continue
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
    if (sql[i] === ';') {
      const current = sql.slice(start, i)
      if (
        !(tsqlBlock && tsqlBlock.test(blankLiterals(current, dialect))) &&
        !insideMysqlBody(current, dialect)
      ) {
        push(i, i + 1)
      }
    }
    i++
  }
  push(n, n)
  return out
}

/**
 * Where the comment, string, quoted identifier or dollar-quoted body starting at `i` ends,
 * or -1 when none starts there. A line comment ends before its line break.
 */
export function skipQuoted(sql: string, i: number, dialect: Dialect): number {
  const n = sql.length
  const c = sql[i]
  const next = sql[i + 1]
  if ((c === '-' && next === '-') || (c === '#' && dialect === 'mysql')) {
    const end = sql.indexOf('\n', i)
    return end < 0 ? n : end
  }
  if (c === '/' && next === '*') {
    // PostgreSQL and SQL Server nest block comments
    const nests = dialect === 'postgres' || dialect === 'tsql'
    let depth = 1
    let j = i + 2
    while (j < n) {
      if (sql[j] === '*' && sql[j + 1] === '/') {
        j += 2
        if (--depth === 0) return j
      } else if (nests && sql[j] === '/' && sql[j + 1] === '*') {
        j += 2
        depth++
      } else j++
    }
    return n
  }
  if (c === "'" || c === '"' || c === '`' || (c === '[' && dialect === 'tsql')) {
    const close = c === '[' ? ']' : c
    // MySQL strings and PostgreSQL E'…' strings take backslash escapes
    const backslash =
      (dialect === 'mysql' && c !== '`') ||
      (dialect === 'postgres' &&
        c === "'" &&
        /[Ee]/.test(sql[i - 1] ?? '') &&
        !/[A-Za-z0-9_$]/.test(sql[i - 2] ?? ''))
    let j = i + 1
    while (j < n) {
      if (backslash && sql[j] === '\\') {
        j += 2
        continue
      }
      if (sql[j] === close) {
        // A doubled quote is an escaped one
        if (sql[j + 1] !== close) return j + 1
        j++
      }
      j++
    }
    return n
  }
  if (c === '$' && dialect === 'postgres') {
    const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))
    if (m) {
      const end = sql.indexOf(m[0], i + m[0].length)
      return end < 0 ? n : end + m[0].length
    }
  }
  return -1
}

/**
 * `sql` read as `dialect`, without comments and with strings emptied to `''`.
 * Quoted identifiers are kept.
 */
export function blankLiterals(sql: string, dialect: Dialect): string {
  let out = ''
  let from = 0
  let i = 0
  while (i < sql.length) {
    const end = skipQuoted(sql, i, dialect)
    if (end < 0) {
      i++
      continue
    }
    const c = sql[i]
    const name = c === '`' || c === '[' || (c === '"' && dialect !== 'mysql')
    const comment = c === '-' || c === '#' || c === '/'
    out += sql.slice(from, i) + (name ? sql.slice(i, end) : comment ? ' ' : "''")
    i = from = end
  }
  return out + sql.slice(from)
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
    const s = blankLiterals(statement.text, dialect).trim()
    // Routine bodies run later, if at all; in T-SQL the rest of the batch is the body
    if (
      /^create\s+(or\s+(replace|alter)\s+)?(definer\s*=\s*\S+\s+)?(proc|procedure|function|trigger|event|rule|view|package)\b/i.test(
        s
      )
    )
      continue
    // Only EXPLAIN ANALYZE runs the statement
    if (
      /^explain\b/i.test(s) &&
      !/^explain\s+(analy[sz]e\b|\([^)]*\banaly[sz]e\b(?!\s+(false|off)\b))/i.test(s)
    )
      continue
    const alter = /^alter\b/i.test(s)
    if (alter && /^alter\s+table\b[\s\S]*\bdrop\b/i.test(s)) reasons.push('ALTER TABLE … DROP')
    const tokens = [...s.matchAll(/"(?:[^"]|"")*"|\[(?:[^\]]|\]\])*\]|`(?:[^`]|``)*`|[\w$#@]+|\S/g)]
    const words = tokens.map((t) => t[0].toLowerCase())
    // Parenthesis depth of each token
    const depths: number[] = []
    let depth = 0
    for (const w of words) {
      if (w === ')') depth--
      depths.push(depth)
      if (w === '(') depth++
    }
    // T-SQL needs no semicolons, so a statement can start at any word
    const startsStatement = (k: number, keywords: Set<string>): boolean =>
      keywords.has(words[k]) && !NOT_A_STATEMENT.has(words[k - 1])
    // Words of the statement starting at `k`, at its own depth
    const clause = (k: number): string[] => {
      const out: string[] = []
      for (let j = k + 1; j < words.length && depths[j] >= depths[k]; j++) {
        if (depths[j] !== depths[k]) continue
        if (startsStatement(j, STATEMENT_START)) break
        out.push(words[j])
      }
      return out
    }
    for (let k = 0; k < words.length; k++) {
      if (!startsStatement(k, WRITES)) continue
      const w = words[k]
      // MariaDB: removes old versions of a system-versioned table's rows
      if (w === 'delete' && words[k + 1] === 'history') reasons.push('DELETE HISTORY')
      else if ((w === 'delete' || w === 'update') && !clause(k).includes('where'))
        reasons.push(`${w.toUpperCase()} without a WHERE clause`)
      else if (w === 'merge' && clause(k).includes('delete')) reasons.push('MERGE … DELETE')
      else if (w === 'drop' && !alter && DROPPED.has(words[k + 1]))
        reasons.push(s.slice(tokens[k].index).split(/\s+/).slice(0, 3).join(' ').toUpperCase())
      else if (w === 'truncate') reasons.push('TRUNCATE')
    }
  }
  return [...new Set(reasons)]
}

const WRITES = new Set(['delete', 'update', 'merge', 'drop', 'truncate'])

/** Words that start a statement, ending the one before when T-SQL leaves out the `;`. */
const STATEMENT_START = new Set([
  ...WRITES,
  'select',
  'insert',
  'alter',
  'create',
  'exec',
  'execute',
  'declare',
  'print'
])

/** Words before DELETE, UPDATE and the like that make them part of another statement. */
const NOT_A_STATEMENT = new Set([
  ',',
  'on', // ON DELETE CASCADE
  'for', // FOR UPDATE, policies
  'after', // triggers
  'before',
  'of', // INSTEAD OF DELETE
  'or',
  'key', // ON DUPLICATE KEY UPDATE, FOR NO KEY UPDATE
  'share', // SHARE UPDATE EXCLUSIVE
  'do', // ON CONFLICT DO UPDATE
  'then', // MERGE … WHEN MATCHED THEN UPDATE
  'grant',
  'revoke',
  'deny'
])

/** Objects whose DROP deserves a confirmation. */
const DROPPED = new Set([
  'table',
  'temporary',
  'database',
  'schema',
  'view',
  'materialized',
  'index',
  'function',
  'procedure',
  'collection',
  'user',
  'owned',
  'role',
  'login',
  'sequence',
  'trigger',
  'type',
  'extension',
  'tablespace',
  'event'
])

export function explainSql(
  sql: string,
  dialect: Dialect,
  analyze: boolean,
  babelfish: boolean,
  mariadb = false
): string {
  const body = sql.trim().replace(/;\s*$/, '')
  switch (dialect) {
    case 'postgres':
      return `EXPLAIN (${analyze ? 'ANALYZE, BUFFERS, ' : ''}VERBOSE, FORMAT JSON)\n${body}`
    case 'mysql':
      // MariaDB has neither FORMAT=TREE nor EXPLAIN ANALYZE; its ANALYZE runs the statement
      if (mariadb) return `${analyze ? 'ANALYZE' : 'EXPLAIN'} FORMAT=JSON\n${body}`
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
  const text = blankLiterals(current, dialect)
  // MariaDB packages and Oracle-mode routines nest differently
  const mariaDb = insideMariaDbBlock(text)
  if (mariaDb !== null) return mariaDb
  if (
    !/^\s*create\s+(or\s+replace\s+)?(definer\s*=\s*\S+\s+)?(procedure|function|trigger|event)\b/i.test(
      text
    )
  )
    return false
  // Quoted names may hold any word
  const words = (text.replace(/`(?:[^`]|``)*`/g, ' ').match(/[A-Za-z_][\w$]*/g) ?? []).map((w) =>
    w.toLowerCase()
  )
  let depth = 0
  for (let k = 0; k < words.length; k++) {
    const w = words[k]
    // A CASE (statement or expression) ends at END CASE or a bare END
    if (w === 'begin' || (w === 'case' && words[k - 1] !== 'end')) depth++
    // END IF / END LOOP / END WHILE / END REPEAT close blocks whose openers aren't counted
    else if (w === 'end' && !/^(if|loop|while|repeat)$/.test(words[k + 1] ?? '')) depth--
  }
  return depth > 0
}
