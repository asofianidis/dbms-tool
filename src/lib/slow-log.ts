/**
 * The MySQL / MariaDB slow query log, read from `mysql.slow_log` when `log_output` includes
 * TABLE. This complements the performance_schema digest list in server-perf.ts: the log keeps
 * individual executions with their real literals and timestamps, and it works on MariaDB,
 * where performance_schema is off by default.
 */
import type { Cell, ColumnMeta, ResultSet } from './api'

/** The statement that turns the log on, shown as a hint and never run without asking. */
export const ENABLE_SLOW_LOG_SQL =
  "SET GLOBAL slow_query_log=ON, log_output='TABLE,FILE', long_query_time=1"

const STATUS_VARIABLES = [
  'slow_query_log',
  'long_query_time',
  'log_output',
  'slow_query_log_file',
  'log_queries_not_using_indexes',
  'min_examined_row_limit'
]

const MARIADB_STATUS_VARIABLES = ['log_slow_verbosity', 'log_slow_filter', 'log_slow_rate_limit']

/**
 * Server settings that decide what the slow log records and where. The GLOBAL values: a session
 * keeps the long_query_time it started with (and on MariaDB can turn its own logging off).
 */
export function slowLogStatusSql(mariadb: boolean): string {
  const names = mariadb ? [...STATUS_VARIABLES, ...MARIADB_STATUS_VARIABLES] : STATUS_VARIABLES
  return `SELECT ${names.map((n) => `@@GLOBAL.${n} AS ${n}`).join(',\n  ')}`
}

export interface SlowLogStatus {
  enabled: boolean
  longQueryTime: number | null
  /** TABLE, FILE and/or NONE */
  outputs: string[]
  /** Every setting the status query read, by variable name */
  settings: [name: string, value: string | null][]
}

/** Reads the status query's single row. */
export function parseSlowLogStatus(set: ResultSet | null): SlowLogStatus | null {
  const row = set?.rows[0]
  if (!set || !row) return null
  const settings = set.columns.map((c, i): [string, string | null] => [
    c.name,
    row[i] === null ? null : String(row[i])
  ])
  const get = (name: string): string | null => settings.find(([n]) => n === name)?.[1] ?? null
  const enabled = get('slow_query_log')
  const time = Number(get('long_query_time'))
  return {
    enabled: enabled === '1' || enabled?.toUpperCase() === 'ON',
    longQueryTime: get('long_query_time') !== null && Number.isFinite(time) ? time : null,
    outputs: (get('log_output') ?? '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
    settings
  }
}

/** Whether the server writes slow statements to mysql.slow_log. */
export function logsToTable(status: SlowLogStatus): boolean {
  return status.outputs.includes('TABLE')
}

/** A preset window ending now, or explicit `YYYY-MM-DD HH:MM[:SS]` bounds (either may be empty). */
export type SlowLogRange = { minutes: number | null } | { from: string; to: string }

export const SLOW_LOG_RANGES: { value: string; label: string; minutes: number | null }[] = [
  { value: '15m', label: 'Last 15 min', minutes: 15 },
  { value: '1h', label: 'Last hour', minutes: 60 },
  { value: '6h', label: 'Last 6 hours', minutes: 360 },
  { value: '24h', label: 'Last 24 hours', minutes: 1440 },
  { value: '7d', label: 'Last 7 days', minutes: 10080 },
  { value: 'all', label: 'All entries', minutes: null }
]

export type SlowLogSort = 'start_time' | 'query_time' | 'lock_time' | 'rows_examined' | 'rows_sent'

export const SLOW_LOG_SORTS: { value: SlowLogSort; label: string }[] = [
  { value: 'start_time', label: 'Newest first' },
  { value: 'query_time', label: 'Slowest first' },
  { value: 'lock_time', label: 'Longest lock wait' },
  { value: 'rows_examined', label: 'Most rows examined' },
  { value: 'rows_sent', label: 'Most rows sent' }
]

export interface SlowLogFilter {
  range: SlowLogRange
  /** Leave out the viewer's own reads of mysql.slow_log, which long_query_time=0 also logs */
  hideOwn: boolean
}

// MySQL stores sql_text as a mediumblob, which the driver would send as hex
const SQL_TEXT = 'CONVERT(sql_text USING utf8mb4)'

/** Seconds as a decimal; MySQL's TIME_TO_SEC drops the fraction that MariaDB's keeps. */
function seconds(column: string): string {
  return `FLOOR(TIME_TO_SEC(${column})) + MICROSECOND(${column}) * 0.000001`
}

const DATETIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?$/

function where(filter: SlowLogFilter): string {
  const conditions: string[] = []
  const { range } = filter
  if ('minutes' in range) {
    if (range.minutes !== null)
      conditions.push(`start_time >= NOW(6) - INTERVAL ${Math.floor(range.minutes)} MINUTE`)
  } else {
    // Only well-formed timestamps reach the SQL; anything else leaves that bound open
    const from = range.from.trim()
    const to = range.to.trim()
    if (DATETIME.test(from)) conditions.push(`start_time >= '${from.replace('T', ' ')}'`)
    if (DATETIME.test(to)) conditions.push(`start_time < '${to.replace('T', ' ')}'`)
  }
  if (filter.hideOwn) conditions.push(`${SQL_TEXT} NOT LIKE '%mysql.slow_log%'`)
  return conditions.length ? `\nWHERE ${conditions.join('\n  AND ')}` : ''
}

export const SLOW_LOG_PAGE_SIZE = 100

/** One page of log entries. MariaDB's table adds rows_affected. */
export function slowLogEntriesSql(
  filter: SlowLogFilter,
  options: { sort: SlowLogSort; page: number; pageSize?: number; mariadb: boolean }
): string {
  const size = options.pageSize ?? SLOW_LOG_PAGE_SIZE
  const offset = Math.max(0, Math.floor(options.page)) * size
  const order =
    options.sort === 'start_time' ? 'start_time DESC' : `${options.sort} DESC, start_time DESC`
  return `SELECT start_time, user_host, ROUND(${seconds('query_time')}, 6) AS query_time_s,
  ROUND(${seconds('lock_time')}, 6) AS lock_time_s, rows_sent, rows_examined,${
    options.mariadb ? ' rows_affected,' : ''
  } db, thread_id,
  ${SQL_TEXT} AS sql_text
FROM mysql.slow_log${where(filter)}
ORDER BY ${order}
LIMIT ${size} OFFSET ${offset}`
}

/** How many entries match, for the pager. */
export function slowLogCountSql(filter: SlowLogFilter): string {
  return `SELECT COUNT(*) AS entries FROM mysql.slow_log${where(filter)}`
}

/** Entries grouped in the app read at most this many of the newest matching rows. */
export const SLOW_LOG_GROUP_LIMIT = 5000

/** The newest matching entries with just what grouping needs. */
export function slowLogGroupSql(filter: SlowLogFilter, limit = SLOW_LOG_GROUP_LIMIT): string {
  return `SELECT start_time, ROUND(${seconds('query_time')}, 6) AS query_time_s,
  ROUND(${seconds('lock_time')}, 6) AS lock_time_s, rows_sent, rows_examined, db,
  ${SQL_TEXT} AS sql_text
FROM mysql.slow_log${where(filter)}
ORDER BY start_time DESC
LIMIT ${limit}`
}

/** What to tell the user when mysql.slow_log can't be read. */
export function slowLogHint(error: string): string | null {
  if (/denied/i.test(error)) return 'Reading mysql.slow_log needs the SELECT privilege on mysql.*.'
  return null
}

/* ---------- Normalization ---------- */

// Upper-cased so `select` and `SELECT` group together; other words keep their case
const KEYWORDS = new Set(
  `select from where and or not in is null like between insert into values value update set
  delete replace join left right inner outer cross straight_join natural on using group by order
  having limit offset as distinct union all asc desc case when then else end exists with
  recursive call show create alter drop table index view duplicate key for lock share mode
  ignore low_priority high_priority delayed quick interval escape regexp rlike div mod xor
  true false unknown default over partition window rows range preceding following current row`
    .split(/\s+/)
    .filter(Boolean)
)

// Upper-cased and written without a space before their parenthesis
const FUNCTIONS = new Set(
  `count sum avg min max sleep now concat coalesce ifnull if nullif cast convert date
  date_format date_add date_sub lower upper length substring substr trim round floor ceil
  abs group_concat json_extract json_unquote unix_timestamp from_unixtime curdate
  current_timestamp last_insert_id found_rows row_number rank dense_rank`
    .split(/\s+/)
    .filter(Boolean)
)

type Kind = 'word' | 'keyword' | 'function' | 'value' | 'open' | 'close' | 'punct' | 'op'

const OPERATORS = ['<=>', '->>', '<=', '>=', '<>', '!=', ':=', '||', '&&', '->', '<<', '>>']

/**
 * A digest-like fingerprint: comments dropped, literals replaced by `?`, IN lists and
 * multi-row VALUES collapsed to `(...)`, keywords upper-cased and whitespace collapsed.
 */
export function normalizeStatement(sql: string): string {
  const tokens: { text: string; kind: Kind }[] = []
  const last = (): Kind | null => tokens[tokens.length - 1]?.kind ?? null
  const value = (): void => {
    tokens.push({ text: '?', kind: 'value' })
  }
  const n = sql.length
  let i = 0
  const skipString = (quote: string): void => {
    i++
    while (i < n) {
      if (sql[i] === '\\') i += 2
      else if (sql[i] === quote && sql[i + 1] === quote) i += 2
      else if (sql[i] === quote) {
        i++
        return
      } else i++
    }
  }
  while (i < n) {
    const c = sql[i]
    const rest = sql.slice(i, i + 3)
    if (/\s/.test(c)) {
      i++
    } else if (c === '#' || rest.startsWith('--')) {
      while (i < n && sql[i] !== '\n') i++
    } else if (rest.startsWith('/*')) {
      const end = sql.indexOf('*/', i + 2)
      i = end < 0 ? n : end + 2
    } else if (c === "'" || c === '"') {
      skipString(c)
      value()
    } else if (c === '`') {
      const start = i
      i++
      while (i < n && !(sql[i] === '`' && sql[i + 1] !== '`')) i += sql[i] === '`' ? 2 : 1
      i++
      tokens.push({ text: sql.slice(start, i), kind: 'word' })
    } else if (
      /[0-9]/.test(c) ||
      (c === '.' && /[0-9]/.test(sql[i + 1] ?? '')) ||
      // A minus sign starts a negative literal where a value is expected
      (c === '-' &&
        /[0-9.]/.test(sql[i + 1] ?? '') &&
        !['word', 'value', 'close', 'function'].includes(last() ?? ''))
    ) {
      const match = /^-?(0x[0-9a-f]+|0b[01]+|(\d+\.?\d*|\.\d+)(e[+-]?\d+)?)/i.exec(sql.slice(i))
      i += match ? match[0].length : 1
      // Digits that run into letters are part of an identifier like 1st_quarter
      if (/[A-Za-z_$]/.test(sql[i] ?? '')) {
        const start = i - (match?.[0].length ?? 1)
        while (i < n && /[\w$]/.test(sql[i])) i++
        tokens.push({ text: sql.slice(start, i), kind: 'word' })
      } else value()
    } else if (/[A-Za-z_$@]/.test(c) || c.charCodeAt(0) > 127) {
      const start = i
      while (i < n && (/[\w$@]/.test(sql[i]) || sql.charCodeAt(i) > 127)) i++
      const word = sql.slice(start, i)
      const lower = word.toLowerCase()
      // x'0A', b'01', N'text' and _utf8mb4'text' are literals with a prefix
      if (sql[i] === "'" && /^(x|b|n|_\w+)$/i.test(word)) {
        skipString("'")
        value()
      } else if (KEYWORDS.has(lower)) tokens.push({ text: word.toUpperCase(), kind: 'keyword' })
      else if (FUNCTIONS.has(lower) && /^\s*\(/.test(sql.slice(i)))
        tokens.push({ text: word.toUpperCase(), kind: 'function' })
      else tokens.push({ text: word, kind: 'word' })
    } else if (c === '(') {
      tokens.push({ text: c, kind: 'open' })
      i++
    } else if (c === ')') {
      tokens.push({ text: c, kind: 'close' })
      i++
    } else if (c === ',' || c === '.' || c === ';') {
      tokens.push({ text: c, kind: 'punct' })
      i++
    } else if (c === '?') {
      value()
      i++
    } else {
      const op = OPERATORS.find((o) => sql.startsWith(o, i)) ?? c
      tokens.push({ text: op, kind: 'op' })
      i += op.length
    }
  }
  while (tokens.length && tokens[tokens.length - 1].text === ';') tokens.pop()

  let out = ''
  tokens.forEach((t, k) => {
    const prev = tokens[k - 1]
    const tight =
      !prev ||
      prev.text === '(' ||
      prev.text === '.' ||
      t.text === ',' ||
      t.text === ')' ||
      t.text === '.' ||
      t.text === ';' ||
      (t.text === '(' && (prev.kind === 'function' || prev.kind === 'word'))
    out += (tight ? '' : ' ') + t.text
  })
  return (
    out
      // IN (?, ?, ?) of any length is one statement shape
      .replace(/\bIN\s*\(\s*\?(?:\s*,\s*\?)*\s*\)/g, 'IN (...)')
      // So are multi-row inserts, whatever the row count
      .replace(/\bVALUES?\s*\([?,\s]*\)(?:\s*,\s*\([?,\s]*\))*/g, 'VALUES (...)')
  )
}

/* ---------- Grouping ---------- */

export interface SlowLogGroup {
  fingerprint: string
  count: number
  totalSecs: number
  maxSecs: number
  lockSecs: number
  rowsExamined: number
  rowsSent: number
  /** start_time of the newest entry */
  lastSeen: string
  /** The slowest entry's text and database, to open or explain */
  sample: string
  db: string
}

export type SlowLogGroupSort = 'total' | 'avg' | 'max' | 'count'

export const SLOW_LOG_GROUP_SORTS: { value: SlowLogGroupSort; label: string; title: string }[] = [
  {
    value: 'total',
    label: 'Total time',
    title: 'Statements that cost the server the most overall'
  },
  { value: 'avg', label: 'Avg time', title: 'Statements that are slowest each time they run' },
  { value: 'max', label: 'Max time', title: 'Statements with the slowest single run' },
  { value: 'count', label: 'Count', title: 'Statements logged most often' }
]

function column(set: ResultSet, name: string): number {
  return set.columns.findIndex((c) => c.name === name)
}

function num(cell: Cell | undefined): number {
  const v = Number(cell ?? 0)
  return Number.isFinite(v) ? v : 0
}

/** Groups entries from `slowLogGroupSql` by normalized statement. */
export function groupSlowLog(set: ResultSet, sort: SlowLogGroupSort = 'total'): SlowLogGroup[] {
  const at = {
    start: column(set, 'start_time'),
    time: column(set, 'query_time_s'),
    lock: column(set, 'lock_time_s'),
    sent: column(set, 'rows_sent'),
    examined: column(set, 'rows_examined'),
    db: column(set, 'db'),
    text: column(set, 'sql_text')
  }
  const groups = new Map<string, SlowLogGroup>()
  for (const row of set.rows) {
    const text = row[at.text]
    if (typeof text !== 'string' || !text.trim()) continue
    const fingerprint = normalizeStatement(text)
    const secs = num(row[at.time])
    const start = String(row[at.start] ?? '')
    const db = String(row[at.db] ?? '')
    let g = groups.get(fingerprint)
    if (!g) {
      g = {
        fingerprint,
        count: 0,
        totalSecs: 0,
        maxSecs: -1,
        lockSecs: 0,
        rowsExamined: 0,
        rowsSent: 0,
        lastSeen: start,
        sample: text,
        db
      }
      groups.set(fingerprint, g)
    }
    g.count++
    g.totalSecs += secs
    g.lockSecs += num(row[at.lock])
    g.rowsExamined += num(row[at.examined])
    g.rowsSent += num(row[at.sent])
    if (start > g.lastSeen) g.lastSeen = start
    if (secs > g.maxSecs) {
      g.maxSecs = secs
      g.sample = text
      g.db = db
    }
  }
  return sortGroups([...groups.values()], sort)
}

export function sortGroups(groups: SlowLogGroup[], sort: SlowLogGroupSort): SlowLogGroup[] {
  const key = (g: SlowLogGroup): number =>
    sort === 'total'
      ? g.totalSecs
      : sort === 'avg'
        ? g.totalSecs / g.count
        : sort === 'max'
          ? g.maxSecs
          : g.count
  return [...groups].sort((a, b) => key(b) - key(a) || b.totalSecs - a.totalSecs)
}

/** Seconds to at most six decimals, without trailing zeros. */
function secs(value: number): string {
  return String(Number(value.toFixed(6)))
}

const GROUP_COLUMNS: ColumnMeta[] = [
  { name: 'count', typeName: 'bigint' },
  { name: 'total_s', typeName: 'decimal' },
  { name: 'avg_s', typeName: 'decimal' },
  { name: 'max_s', typeName: 'decimal' },
  { name: 'avg_lock_s', typeName: 'decimal' },
  { name: 'avg_rows_examined', typeName: 'decimal' },
  { name: 'avg_rows_sent', typeName: 'decimal' },
  { name: 'last_seen', typeName: 'timestamp' },
  { name: 'db', typeName: 'varchar' },
  { name: 'statement', typeName: 'text' }
]

/** Groups as a grid, one row per group in the same order. */
export function groupsToSet(groups: SlowLogGroup[]): ResultSet {
  return {
    columns: GROUP_COLUMNS,
    rows: groups.map((g) => [
      String(g.count),
      secs(g.totalSecs),
      secs(g.totalSecs / g.count),
      secs(g.maxSecs),
      secs(g.lockSecs / g.count),
      String(Math.round(g.rowsExamined / g.count)),
      String(Math.round(g.rowsSent / g.count)),
      g.lastSeen,
      g.db,
      g.fingerprint
    ]),
    rowCount: groups.length,
    truncated: false
  }
}

/** Whether EXPLAIN accepts the statement (and doesn't run it). */
export function explainable(sql: string): boolean {
  const body = sql
    .replace(/^(\s+|--[^\n]*\n?|#[^\n]*\n?|\/\*[\s\S]*?\*\/)+/, '')
    .replace(/^\(+\s*/, '')
  return /^(select|with|insert|update|delete|replace|table)\b/i.test(body)
}
