import type { Cell } from './api'
import { newColumn, tableStatements, type TableDraft } from './ddl'
import type { Dialect } from './engines'
import { literal, qualified, quoteIdent, type TableRef } from './sql'

/* ---------- Reading files ---------- */

export type ImportFormat = 'csv' | 'json' | 'jsonl'

export interface CsvOptions {
  delimiter: string
  /** Empty for files that never quote */
  quote: string
  header: boolean
}

export const DEFAULT_CSV: CsvOptions = { delimiter: ',', quote: '"', header: true }

/** Format (and CSV delimiter) suggested by a file's extension. */
export function detectFormat(path: string): { format: ImportFormat; delimiter: string } {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  if (ext === 'json') return { format: 'json', delimiter: ',' }
  if (ext === 'jsonl' || ext === 'ndjson') return { format: 'jsonl', delimiter: ',' }
  if (ext === 'tsv' || ext === 'tab') return { format: 'csv', delimiter: '\t' }
  return { format: 'csv', delimiter: ',' }
}

/**
 * RFC 4180 records: quoted fields may hold delimiters, doubled quotes and
 * line breaks; records end at LF, CRLF or CR. A trailing newline doesn't make
 * an empty record.
 */
export function parseCsv(text: string, delimiter = ',', quote = '"'): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const records: string[][] = []
  let record: string[] = []
  let field = ''
  let quoted = false
  let i = 0
  const n = src.length
  const endRecord = (): void => {
    record.push(field)
    records.push(record)
    record = []
    field = ''
  }
  while (i < n) {
    const ch = src[i]
    if (quoted) {
      if (ch === quote) {
        if (src[i + 1] === quote) {
          field += quote
          i += 2
          continue
        }
        quoted = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }
    if (quote && ch === quote && field === '') {
      quoted = true
      i++
    } else if (ch === delimiter) {
      record.push(field)
      field = ''
      i++
    } else if (ch === '\n' || ch === '\r') {
      endRecord()
      i += ch === '\r' && src[i + 1] === '\n' ? 2 : 1
    } else {
      field += ch
      i++
    }
  }
  if (field !== '' || record.length || quoted) endRecord()
  return records
}

export interface ParsedFile {
  columns: string[]
  /** Strings from CSV; strings, booleans and nulls from JSON */
  rows: Cell[][]
  /** JSON documents as read, for MongoDB; null for CSV */
  documents: Record<string, unknown>[] | null
}

/** Column names with blanks filled in and duplicates numbered. */
export function uniqueColumnNames(raw: string[]): string[] {
  const seen = new Map<string, number>()
  return raw.map((name, i) => {
    let base = name.trim() || `column_${i + 1}`
    const key = base.toLowerCase()
    const count = seen.get(key) ?? 0
    seen.set(key, count + 1)
    if (count) base = `${base}_${count + 1}`
    return base
  })
}

export function parseFile(text: string, format: ImportFormat, csv: CsvOptions): ParsedFile {
  if (format === 'csv') {
    const records = parseCsv(text, csv.delimiter, csv.quote)
    const header = csv.header ? (records.shift() ?? []) : []
    const width = records.reduce((w, r) => Math.max(w, r.length), header.length)
    const names = Array.from({ length: width }, (_, i) =>
      csv.header ? (header[i] ?? '') : `column_${i + 1}`
    )
    const rows = records.map((r) =>
      r.length === width ? r : [...r, ...Array<string>(width - r.length).fill('')]
    )
    return { columns: uniqueColumnNames(names), rows, documents: null }
  }
  const parsed = parseJsonDocuments(text, format)
  const columns: string[] = []
  const known = new Set<string>()
  for (const doc of parsed) {
    for (const key of Object.keys(doc)) {
      if (!known.has(key)) {
        known.add(key)
        columns.push(key)
      }
    }
  }
  const rows = parsed.map((doc) => columns.map((c) => jsonCell(doc[c])))
  const documents = parsed.map((doc) => mongoValue(doc) as Record<string, unknown>)
  return { columns, rows, documents }
}

function asDocument(value: unknown): Record<string, unknown> {
  return value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof JsonNumber)
    ? (value as Record<string, unknown>)
    : { value }
}

function parseJsonDocuments(text: string, format: ImportFormat): Record<string, unknown>[] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  if (format === 'json') {
    try {
      const value = parseJson(src)
      return Array.isArray(value) ? value.map(asDocument) : [asDocument(value)]
    } catch (e) {
      // mongoexport writes one document per line even to .json files
      if (!src.trimStart().startsWith('{')) throw e
    }
  }
  const out: Record<string, unknown>[] = []
  src.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return
    try {
      out.push(asDocument(parseJson(line)))
    } catch (e) {
      throw new Error(`Line ${i + 1}: ${e instanceof Error ? e.message : String(e)}`)
    }
  })
  return out
}

/** A JSON number as written in the file, so big integers and long decimals keep every digit. */
export class JsonNumber {
  constructor(readonly text: string) {}
}

const JSON_NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?/y
const JSON_STRING_STOP = /["\\]/g
const JSON_WORDS = [
  ['true', true],
  ['false', false],
  ['null', null]
] as const

/**
 * JSON.parse, except that numbers come back as JsonNumber holding their
 * source text: JSON.parse rounds them to doubles, and only some engines show
 * a reviver the source text.
 */
export function parseJson(text: string): unknown {
  let i = 0
  const fail = (what?: string): never => {
    throw new SyntaxError(
      `Unexpected ${what ?? (i < text.length ? `token ${text[i]}` : 'end of JSON input')} at position ${i}`
    )
  }
  const space = (): void => {
    while (i < text.length) {
      const c = text.charCodeAt(i)
      if (c !== 0x20 && c !== 0x0a && c !== 0x0d && c !== 0x09) break
      i++
    }
  }
  const string = (): string => {
    const start = i++
    let escaped = false
    for (;;) {
      JSON_STRING_STOP.lastIndex = i
      const m = JSON_STRING_STOP.exec(text)
      if (!m) {
        i = text.length
        return fail()
      }
      i = m.index + 1
      if (m[0] === '"') break
      // Skip the escaped character
      escaped = true
      i++
    }
    const raw = text.slice(start, i)
    // eslint-disable-next-line no-control-regex
    if (!escaped && !/[\u0000-\u001f]/.test(raw)) return raw.slice(1, -1)
    try {
      return JSON.parse(raw) as string
    } catch {
      i = start
      return fail('string')
    }
  }
  const value = (): unknown => {
    space()
    const c = text[i]
    if (c === '{') {
      i++
      const obj: Record<string, unknown> = {}
      space()
      if (text[i] === '}') {
        i++
        return obj
      }
      for (;;) {
        space()
        if (text[i] !== '"') fail()
        const key = string()
        space()
        if (text[i] !== ':') fail()
        i++
        const v = value()
        // Assigning __proto__ would set the prototype rather than a field
        if (key === '__proto__')
          Object.defineProperty(obj, key, {
            value: v,
            enumerable: true,
            writable: true,
            configurable: true
          })
        else obj[key] = v
        space()
        if (text[i] === ',') i++
        else if (text[i] === '}') {
          i++
          return obj
        } else fail()
      }
    }
    if (c === '[') {
      i++
      const arr: unknown[] = []
      space()
      if (text[i] === ']') {
        i++
        return arr
      }
      for (;;) {
        arr.push(value())
        space()
        if (text[i] === ',') i++
        else if (text[i] === ']') {
          i++
          return arr
        } else fail()
      }
    }
    if (c === '"') return string()
    if (c === '-' || (c >= '0' && c <= '9')) {
      JSON_NUMBER.lastIndex = i
      const m = JSON_NUMBER.exec(text) ?? fail()
      i += m[0].length
      return new JsonNumber(m[0])
    }
    for (const [word, v] of JSON_WORDS) {
      if (text.startsWith(word, i)) {
        i += word.length
        return v
      }
    }
    return fail()
  }
  const result = value()
  space()
  if (i < text.length) fail()
  return result
}

/** Parsed JSON as text, numbers as written. */
function stringifyJson(value: unknown): string {
  if (value instanceof JsonNumber) return value.text
  if (Array.isArray(value)) return `[${value.map(stringifyJson).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .map(([k, v]) => `${JSON.stringify(k)}:${stringifyJson(v)}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

const INT64_MAX = 9223372036854775807n

/**
 * A parsed JSON value as a MongoDB document value: integers past 2^53 become
 * Int64 or Decimal128 extended JSON so they stay exact; other numbers are doubles.
 */
export function mongoValue(value: unknown): unknown {
  if (value instanceof JsonNumber) {
    const n = Number(value.text)
    if (!INT.test(value.text) || Number.isSafeInteger(n)) return n
    const big = BigInt(value.text)
    if (big <= INT64_MAX && big >= -INT64_MAX - 1n) return { $numberLong: big.toString() }
    // Decimal128 holds 34 significant digits
    return value.text.replace(/^-/, '').length <= 34 ? { $numberDecimal: value.text } : n
  }
  if (Array.isArray(value)) return value.map(mongoValue)
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mongoValue(v)]))
  return value
}

/** A JSON value as a grid cell; extended JSON wrappers ({ $oid }, { $date }) unwrap to their value. */
export function jsonCell(value: unknown): Cell {
  if (value === null || value === undefined) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (value instanceof JsonNumber) return value.text
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  if (typeof value === 'object' && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 1 && entries[0][0].startsWith('$')) {
      const inner = entries[0][1]
      if (inner instanceof JsonNumber) return inner.text
      if (typeof inner === 'string' || typeof inner === 'number') return String(inner)
      if (inner && typeof inner === 'object' && '$numberLong' in inner)
        return jsonCell((inner as { $numberLong: unknown }).$numberLong)
    }
  }
  return stringifyJson(value)
}

/* ---------- Type inference ---------- */

export type ValueKind =
  | 'integer'
  | 'bigint'
  | 'numeric'
  | 'float'
  | 'boolean'
  | 'date'
  | 'timestamp'
  | 'timestamptz'
  | 'json'
  | 'text'

export interface ColumnProfile {
  /** null when every value is empty */
  kind: ValueKind | null
  maxLength: number
  intDigits: number
  fracDigits: number
}

const INT = /^[-+]?\d+$/
const DECIMAL = /^[-+]?(\d+\.\d*|\.\d+)$/
const FLOAT = /^[-+]?(\d+\.?\d*|\.\d+)e[-+]?\d+$/i
const BOOL = /^(true|false)$/i
const DATE = /^\d{4}-\d{2}-\d{2}$/
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?$/
const TIMESTAMPTZ =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}(:?\d{2})?)$/i
const INT32_MAX = 2147483647n

function kindOf(v: string | boolean): ValueKind {
  if (typeof v === 'boolean') return 'boolean'
  const s = v.trim()
  // Leading zeros (zip codes, account numbers) would be lost as numbers
  if (/^[-+]?0\d/.test(s)) return 'text'
  if (INT.test(s)) {
    const digits = s.replace(/^[-+]/, '').length
    if (digits > 18) return 'numeric'
    const big = BigInt(s)
    return big > INT32_MAX || big < -INT32_MAX - 1n ? 'bigint' : 'integer'
  }
  if (DECIMAL.test(s)) return 'numeric'
  if (FLOAT.test(s)) return 'float'
  if (BOOL.test(s)) return 'boolean'
  if (DATE.test(s)) return 'date'
  if (TIMESTAMP.test(s)) return 'timestamp'
  if (TIMESTAMPTZ.test(s)) return 'timestamptz'
  if (/^[[{]/.test(s)) {
    try {
      JSON.parse(s)
      return 'json'
    } catch {
      return 'text'
    }
  }
  return 'text'
}

const NUMBER_RANK: Partial<Record<ValueKind, number>> = {
  integer: 0,
  bigint: 1,
  numeric: 2,
  float: 3
}

function merge(a: ValueKind | null, b: ValueKind): ValueKind {
  if (a === null || a === b) return b
  const ra = NUMBER_RANK[a]
  const rb = NUMBER_RANK[b]
  if (ra !== undefined && rb !== undefined) return ra > rb ? a : b
  if ((a === 'date' && b === 'timestamp') || (a === 'timestamp' && b === 'date')) return 'timestamp'
  return 'text'
}

/** The narrowest kind that fits every non-empty value in column `col`. */
export function profileColumn(rows: Cell[][], col: number): ColumnProfile {
  const p: ColumnProfile = { kind: null, maxLength: 0, intDigits: 0, fracDigits: 0 }
  for (const row of rows) {
    const v = row[col]
    if (v === null || v === undefined || v === '') continue
    const kind = kindOf(v)
    p.kind = merge(p.kind, kind)
    if (typeof v === 'string') {
      p.maxLength = Math.max(p.maxLength, v.length)
      if (kind === 'integer' || kind === 'bigint' || kind === 'numeric') {
        const [whole, frac = ''] = v.trim().replace(/^[-+]/, '').split('.')
        p.intDigits = Math.max(p.intDigits, whole.replace(/^0+(?=\d)/, '').length)
        p.fracDigits = Math.max(p.fracDigits, frac.length)
      }
    }
  }
  return p
}

function decimalType(name: string, p: ColumnProfile, maxPrecision: number): string {
  const scale = Math.min(p.fracDigits, maxPrecision - 1)
  const precision = Math.min(maxPrecision, Math.max(p.intDigits, 1) + scale + 2)
  return `${name}(${precision},${scale})`
}

/** A column type for values profiled as `p`. */
export function sqlType(dialect: Dialect, p: ColumnProfile): string {
  const kind = p.kind ?? 'text'
  switch (dialect) {
    case 'postgres':
      return {
        integer: 'integer',
        bigint: 'bigint',
        numeric: 'numeric',
        float: 'double precision',
        boolean: 'boolean',
        date: 'date',
        timestamp: 'timestamp',
        timestamptz: 'timestamptz',
        json: 'jsonb',
        text: 'text'
      }[kind]
    case 'mysql':
      switch (kind) {
        case 'integer':
          return 'int'
        case 'bigint':
          return 'bigint'
        case 'numeric':
          return decimalType('decimal', p, 65)
        case 'float':
          return 'double'
        case 'boolean':
          return 'boolean'
        case 'date':
          return 'date'
        case 'timestamp':
          return 'datetime(6)'
        case 'json':
          return 'json'
        default:
          // MySQL datetime has no time zone, so offsets stay as text
          return p.maxLength <= 255 ? 'varchar(255)' : p.maxLength <= 16000 ? 'text' : 'longtext'
      }
    case 'tsql':
      switch (kind) {
        case 'integer':
          return 'int'
        case 'bigint':
          return 'bigint'
        case 'numeric':
          return decimalType('decimal', p, 38)
        case 'float':
          return 'float'
        case 'boolean':
          return 'bit'
        case 'date':
          return 'date'
        case 'timestamp':
          return 'datetime2'
        case 'timestamptz':
          return 'datetimeoffset'
        case 'json':
          return 'nvarchar(max)'
        default:
          return p.maxLength <= 255
            ? 'nvarchar(255)'
            : p.maxLength <= 4000
              ? 'nvarchar(4000)'
              : 'nvarchar(max)'
      }
    case 'sqlite':
      switch (kind) {
        case 'integer':
        case 'bigint':
          return 'INTEGER'
        // Numeric affinity like INTEGER, but named so true/false convert to 1/0 on insert
        case 'boolean':
          return 'BOOLEAN'
        case 'numeric':
        case 'float':
          return 'REAL'
        default:
          return 'TEXT'
      }
  }
}

/** A table name from a file name: `Sales Report 2024.csv` → `sales_report_2024`. */
export function tableNameFromPath(path: string): string {
  const base = (path.split(/[\\/]/).pop() ?? '').replace(/\.[^.]*$/, '')
  const name = base
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
  return /^[0-9]/.test(name) ? `t_${name}` : name || 'imported'
}

export interface NewColumn {
  name: string
  dataType: string
}

/** CREATE TABLE statements for a new table holding the imported columns. */
export function createTableStatements(
  dialect: Dialect,
  ref: TableRef,
  columns: NewColumn[]
): string[] {
  const draft: TableDraft = {
    schema: ref.schema,
    name: ref.name,
    columns: columns.map((c) => newColumn(dialect, { name: c.name, dataType: c.dataType })),
    primaryKey: [],
    indexes: [],
    foreignKeys: [],
    checks: [],
    uniques: [],
    original: null
  }
  return tableStatements(dialect, draft)
}

/* ---------- Building inserts ---------- */

const BOOL_TARGET = /^(bool|boolean|bit|tinyint\s*\(\s*1\s*\))(?!\w)/i
const TRUTHY = /^(true|t|yes|y|1)$/i
const FALSY = /^(false|f|no|n|0)$/i

/** A file value ready for `literal` against a column of `dataType`. */
export function toCell(value: Cell, dataType: string, emptyAsNull: boolean): Cell {
  if (value === '' && emptyAsNull) return null
  if (typeof value === 'string' && BOOL_TARGET.test(dataType.trim())) {
    const s = value.trim()
    if (TRUTHY.test(s)) return true
    if (FALSY.test(s)) return false
  }
  return value
}

export interface InsertBatch {
  sql: string
  rows: number
}

export interface BatchLimits {
  maxRows: number
  /** Statement size to stop adding rows at */
  maxBytes: number
}

/**
 * SQL Server allows 1000 rows per VALUES list; SQLite's older builds cap
 * compound VALUES at 500, and D1 rejects statements over 100 KB.
 */
export function batchLimits(dialect: Dialect): BatchLimits {
  switch (dialect) {
    case 'tsql':
      return { maxRows: 1000, maxBytes: 2_000_000 }
    case 'sqlite':
      return { maxRows: 500, maxBytes: 90_000 }
    default:
      return { maxRows: 1000, maxBytes: 2_000_000 }
  }
}

/** Multi-row INSERT statements for `rows`, whose cells line up with `columns`. */
export function insertBatches(
  dialect: Dialect,
  ref: TableRef,
  columns: NewColumn[],
  rows: Cell[][],
  emptyAsNull: boolean,
  limits: BatchLimits = batchLimits(dialect)
): InsertBatch[] {
  const head = `INSERT INTO ${qualified(dialect, ref)} (${columns
    .map((c) => quoteIdent(dialect, c.name))
    .join(', ')}) VALUES\n`
  const batches: InsertBatch[] = []
  let values: string[] = []
  let bytes = head.length
  const flush = (): void => {
    if (!values.length) return
    batches.push({ sql: head + values.join(',\n'), rows: values.length })
    values = []
    bytes = head.length
  }
  for (const row of rows) {
    const tuple = `(${columns
      .map((c, i) => {
        const cell = toCell(row[i] ?? null, c.dataType, emptyAsNull)
        // SQLite stores booleans as 1/0; TRUE/FALSE keywords need 3.23+
        if (dialect === 'sqlite' && typeof cell === 'boolean') return cell ? '1' : '0'
        return literal(dialect, cell, c.dataType)
      })
      .join(', ')})`
    if (values.length && bytes + tuple.length + 2 > limits.maxBytes) flush()
    values.push(tuple)
    bytes += tuple.length + 2
    if (values.length >= limits.maxRows) flush()
  }
  flush()
  return batches
}

export function beginSql(dialect: Dialect): string {
  switch (dialect) {
    case 'mysql':
      return 'START TRANSACTION'
    case 'tsql':
      return 'SET XACT_ABORT ON; BEGIN TRANSACTION'
    default:
      return 'BEGIN'
  }
}

export function commitSql(dialect: Dialect): string {
  return dialect === 'tsql' ? 'COMMIT TRANSACTION' : 'COMMIT'
}

export function rollbackSql(dialect: Dialect): string {
  return dialect === 'tsql' ? 'IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION' : 'ROLLBACK'
}

/* ---------- MongoDB ---------- */

/** A CSV value as a document field: numbers, booleans and nulls when `typed`. */
export function inferValue(value: string, typed: boolean, emptyAsNull: boolean): unknown {
  if (value === '') return emptyAsNull ? null : ''
  if (!typed) return value
  const s = value.trim()
  if (/^(true|false)$/i.test(s)) return s.toLowerCase() === 'true'
  if (/^null$/i.test(s)) return null
  if (/^[-+]?0\d/.test(s)) return value
  if (INT.test(s)) {
    const n = Number(s)
    if (Number.isSafeInteger(n)) return n
    return s.replace(/^[-+]/, '').length <= 18 ? { $numberLong: BigInt(s).toString() } : value
  }
  if (DECIMAL.test(s) || FLOAT.test(s)) {
    const n = Number(s)
    return Number.isFinite(n) ? n : value
  }
  return value
}

/** Documents from CSV rows; dotted headers (`address.city`) become nested fields. */
export function csvDocuments(
  columns: string[],
  rows: Cell[][],
  typed: boolean,
  emptyAsNull: boolean
): Record<string, unknown>[] {
  const paths = columns.map((c) => c.split('.').filter(Boolean))
  return rows.map((row) => {
    const doc: Record<string, unknown> = {}
    paths.forEach((path, i) => {
      const cell = row[i]
      const value = typeof cell === 'string' ? inferValue(cell, typed, emptyAsNull) : cell
      if (!path.length) return
      let target = doc
      for (const key of path.slice(0, -1)) {
        const next = target[key]
        target = (
          next && typeof next === 'object' && !Array.isArray(next) ? next : (target[key] = {})
        ) as Record<string, unknown>
      }
      target[path[path.length - 1]] = value
    })
    return doc
  })
}

/** Documents split into insertMany calls of at most `maxDocs` and roughly `maxBytes` of JSON. */
export function documentBatches<T>(docs: T[], maxDocs = 1000, maxBytes = 8_000_000): T[][] {
  const out: T[][] = []
  let batch: T[] = []
  let bytes = 0
  for (const doc of docs) {
    const size = JSON.stringify(doc)?.length ?? 0
    if (batch.length && (batch.length >= maxDocs || bytes + size > maxBytes)) {
      out.push(batch)
      batch = []
      bytes = 0
    }
    batch.push(doc)
    bytes += size
  }
  if (batch.length) out.push(batch)
  return out
}

/** File column → table column matches by name, ignoring case, spaces and underscores. */
export function autoMap(fileColumns: string[], tableColumns: string[]): (string | null)[] {
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')
  const byName = new Map(tableColumns.map((c) => [norm(c), c]))
  const used = new Set<string>()
  return fileColumns.map((f) => {
    const match = byName.get(norm(f))
    if (!match || used.has(match)) return null
    used.add(match)
    return match
  })
}
