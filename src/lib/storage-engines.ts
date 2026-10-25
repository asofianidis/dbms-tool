import type { Cell } from './api'
import { catalogRows } from './catalog'
import { foreignKeyName, indexName, type TableDraft } from './ddl'
import { literal, qualified } from './sql'

/**
 * MySQL / MariaDB storage engines: which ones the server has, what each can
 * do (transactions, foreign keys, full-text), and the table options the
 * table designer writes (ENGINE, DEFAULT CHARACTER SET / COLLATE, ROW_FORMAT).
 */

export interface StorageEngine {
  name: string
  /** The server's default_storage_engine */
  isDefault: boolean
  comment: string
  /** From ENGINES.TRANSACTIONS; null when the server doesn't say */
  transactional: boolean | null
}

export interface Collation {
  name: string
  charset: string
}

/** What the server offers for the table options pickers. */
export interface StorageCatalog {
  engines: StorageEngine[]
  /** Character set names, sorted */
  charsets: string[]
  collations: Collation[]
}

/** Storage details of an existing table, from information_schema.TABLES. */
export interface TableStorage {
  engine: string
  /** The row format in use (Dynamic, Page…), whether or not it was asked for */
  rowFormat: string | null
  /** ROW_FORMAT given explicitly at CREATE / ALTER time, uppercase; '' for the default */
  explicitRowFormat: string
  collation: string | null
  dataLength: number | null
  indexLength: number | null
  rows: number | null
}

/** A foreign key in another table that references this one. */
export interface InboundKey {
  table: string
  name: string
}

/** Table options as the designer edits them; '' leaves the server default. */
export interface TableOptions {
  engine: string
  charset: string
  collation: string
  rowFormat: string
}

export const DEFAULT_TABLE_OPTIONS: TableOptions = {
  engine: '',
  charset: '',
  collation: '',
  rowFormat: ''
}

/* ---------- Capabilities ---------- */

export type ForeignKeySupport = 'enforced' | 'ignored' | 'rejected'

export interface EngineTraits {
  transactional: boolean
  /** InnoDB enforces them, MyISAM and most others parse and drop them, MyRocks errors */
  foreignKeys: ForeignKeySupport
  fullText: boolean
  /** TEXT / BLOB columns (MEMORY has none) */
  blobs: boolean
  /** Nullable columns and indexes (CSV has neither) */
  nullable: boolean
  indexes: boolean
  /** ROW_FORMAT values beyond DEFAULT; empty when the engine takes none */
  rowFormats: string[]
}

/** Known engines, keyed by uppercase name; anything else gets conservative defaults. */
const KNOWN: Record<string, Partial<EngineTraits>> = {
  INNODB: {
    transactional: true,
    foreignKeys: 'enforced',
    fullText: true,
    rowFormats: ['DYNAMIC', 'COMPACT', 'REDUNDANT', 'COMPRESSED']
  },
  ARIA: { fullText: true, rowFormats: ['PAGE', 'DYNAMIC', 'FIXED'] },
  MYISAM: { fullText: true, rowFormats: ['DYNAMIC', 'FIXED'] },
  MROONGA: { fullText: true },
  MEMORY: { blobs: false },
  CSV: { nullable: false, indexes: false },
  ROCKSDB: { transactional: true, foreignKeys: 'rejected' },
  TOKUDB: { transactional: true },
  NDBCLUSTER: { transactional: true, foreignKeys: 'enforced' },
  NDB: { transactional: true, foreignKeys: 'enforced' }
}

export function engineTraits(name: string, engines: StorageEngine[] = []): EngineTraits {
  const known = KNOWN[name.toUpperCase()] ?? {}
  const reported = engines.find((e) => e.name.toLowerCase() === name.toLowerCase())
  return {
    transactional: reported?.transactional ?? known.transactional ?? false,
    foreignKeys: known.foreignKeys ?? 'ignored',
    fullText: known.fullText ?? false,
    blobs: known.blobs ?? true,
    nullable: known.nullable ?? true,
    indexes: known.indexes ?? true,
    rowFormats: known.rowFormats ?? []
  }
}

/** The engine a table option of '' means. */
export function effectiveEngine(engine: string, engines: StorageEngine[]): string {
  return engine || engines.find((e) => e.isDefault)?.name || 'InnoDB'
}

/* ---------- Catalog queries ---------- */

/** Engines the server can create tables in; ORDER BY keeps the picker stable. */
export const ENGINES_SQL = `SELECT ENGINE, SUPPORT, COMMENT, TRANSACTIONS FROM information_schema.ENGINES WHERE SUPPORT IN ('YES','DEFAULT') ORDER BY ENGINE`

/** Engines that can't hold a designed table: PERFORMANCE_SCHEMA is the server's own, SEQUENCE is CREATE SEQUENCE's */
const NOT_FOR_TABLES = new Set(['PERFORMANCE_SCHEMA', 'SEQUENCE'])

const str = (cell: Cell | undefined): string | null =>
  cell === null || cell === undefined ? null : String(cell)

const num = (cell: Cell | undefined): number | null => {
  const s = str(cell)
  if (s === null || s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** Engine rows, default first and the rest by name. */
export function parseEngines(rows: Cell[][]): StorageEngine[] {
  return rows
    .map((r) => ({
      name: str(r[0]) ?? '',
      isDefault: str(r[1])?.toUpperCase() === 'DEFAULT',
      comment: str(r[2]) ?? '',
      transactional: str(r[3]) === null ? null : str(r[3])!.toUpperCase() === 'YES'
    }))
    .filter((e) => e.name && !NOT_FOR_TABLES.has(e.name.toUpperCase()))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name))
}

/**
 * Collations with their character set. MariaDB 10.10+ lists the UCA 14 ones
 * (utf8mb4_uca1400_ai_ci) under FULL_COLLATION_NAME only.
 */
export const collationsSql = (mariaDb: boolean): string =>
  mariaDb
    ? 'SELECT FULL_COLLATION_NAME, CHARACTER_SET_NAME FROM information_schema.COLLATION_CHARACTER_SET_APPLICABILITY ORDER BY FULL_COLLATION_NAME'
    : 'SELECT COLLATION_NAME, CHARACTER_SET_NAME FROM information_schema.COLLATIONS ORDER BY COLLATION_NAME'

export function parseCollations(rows: Cell[][]): Collation[] {
  return rows
    .map((r) => ({ name: str(r[0]) ?? '', charset: str(r[1]) ?? '' }))
    .filter((c) => c.name && c.charset)
}

export function tableStorageSql(database: string, table: string): string {
  return `SELECT ENGINE, ROW_FORMAT, CREATE_OPTIONS, TABLE_COLLATION, DATA_LENGTH, INDEX_LENGTH, TABLE_ROWS
FROM information_schema.TABLES
WHERE TABLE_SCHEMA = ${literal('mysql', database)} AND TABLE_NAME = ${literal('mysql', table)}`
}

export function parseTableStorage(rows: Cell[][]): TableStorage | null {
  const r = rows[0]
  if (!r || !str(r[0])) return null
  const explicit = /(?:^|\s)row_format=(\w+)/i.exec(str(r[2]) ?? '')
  return {
    engine: str(r[0])!,
    rowFormat: str(r[1]),
    explicitRowFormat: explicit ? explicit[1].toUpperCase() : '',
    collation: str(r[3]),
    dataLength: num(r[4]),
    indexLength: num(r[5]),
    rows: num(r[6])
  }
}

/** Foreign keys elsewhere that point at the table (its own self-references excluded). */
export function inboundKeysSql(database: string, table: string): string {
  const db = literal('mysql', database)
  const name = literal('mysql', table)
  return `SELECT TABLE_NAME, CONSTRAINT_NAME FROM information_schema.REFERENTIAL_CONSTRAINTS
WHERE UNIQUE_CONSTRAINT_SCHEMA = ${db} AND REFERENCED_TABLE_NAME = ${name}
  AND NOT (CONSTRAINT_SCHEMA = ${db} AND TABLE_NAME = ${name})
ORDER BY TABLE_NAME, CONSTRAINT_NAME`
}

export function parseInboundKeys(rows: Cell[][]): InboundKey[] {
  return rows.map((r) => ({ table: str(r[0]) ?? '', name: str(r[1]) ?? '' }))
}

export async function loadStorageCatalog(
  connectionId: string,
  database: string,
  mariaDb: boolean
): Promise<StorageCatalog> {
  const [engines, collations] = await Promise.all([
    catalogRows(connectionId, database, [ENGINES_SQL]),
    catalogRows(connectionId, database, [collationsSql(mariaDb)])
  ])
  const parsed = parseCollations(collations)
  return {
    engines: parseEngines(engines),
    charsets: [...new Set(parsed.map((c) => c.charset))].sort(),
    collations: parsed
  }
}

export async function loadTableStorage(
  connectionId: string,
  database: string,
  table: string
): Promise<TableStorage | null> {
  return parseTableStorage(
    await catalogRows(connectionId, database, [tableStorageSql(database, table)])
  )
}

export async function loadInboundKeys(
  connectionId: string,
  database: string,
  table: string
): Promise<InboundKey[]> {
  return parseInboundKeys(
    await catalogRows(connectionId, database, [inboundKeysSql(database, table)])
  )
}

/* ---------- Designer options ---------- */

/** The options an existing table has, for the designer to diff against. */
export function optionsFromStorage(storage: TableStorage, collations: Collation[]): TableOptions {
  const collation = storage.collation ?? ''
  return {
    engine: storage.engine,
    charset: collations.find((c) => c.name === collation)?.charset ?? '',
    collation,
    rowFormat: storage.explicitRowFormat
  }
}

/** ROW_FORMAT values to offer: the engine's own plus whatever the table already has. */
export function rowFormatChoices(engine: string, current: string): string[] {
  const formats = engineTraits(engine).rowFormats
  return current && !formats.includes(current) ? [...formats, current] : formats
}

/** Options after picking an engine: drops a row format the new engine doesn't take. */
export function withEngine(
  options: TableOptions,
  engine: string,
  engines: StorageEngine[]
): TableOptions {
  const formats = engineTraits(effectiveEngine(engine, engines)).rowFormats
  return {
    ...options,
    engine,
    rowFormat: formats.includes(options.rowFormat) ? options.rowFormat : ''
  }
}

const word = (name: string): string =>
  /^\w+$/.test(name) ? name : `\`${name.replace(/`/g, '``')}\``

/**
 * Table option clauses: for a new table (original null) every option set, for
 * an existing one only those that differ from it.
 */
export function tableOptionClauses(options: TableOptions, original: TableOptions | null): string[] {
  const changed = (key: keyof TableOptions): boolean =>
    original ? options[key] !== original[key] : options[key] !== ''
  const clauses: string[] = []
  if (changed('engine') && options.engine) clauses.push(`ENGINE=${word(options.engine)}`)
  if (changed('charset') || changed('collation')) {
    const charset = options.charset && `DEFAULT CHARACTER SET ${word(options.charset)}`
    const collate = options.collation && `COLLATE ${word(options.collation)}`
    if (charset || collate) clauses.push([charset, collate].filter(Boolean).join(' '))
  }
  if (changed('rowFormat'))
    clauses.push(`ROW_FORMAT=${options.rowFormat ? word(options.rowFormat) : 'DEFAULT'}`)
  return clauses
}

export function countOptionChanges(options: TableOptions, original: TableOptions | null): number {
  if (!original) return 0
  return (['engine', 'charset', 'collation', 'rowFormat'] as const).filter(
    (k) => options[k] !== original[k]
  ).length
}

/**
 * Adds the options to the designer's statements: appended to CREATE TABLE, or
 * as their own ALTER TABLE after the column and key changes (so dropping
 * foreign keys comes before an engine that can't hold them) and before a rename.
 */
export function withTableOptions(
  statements: string[],
  draft: TableDraft,
  options: TableOptions,
  original: TableOptions | null
): string[] {
  const clauses = tableOptionClauses(options, draft.original ? original : null)
  if (!clauses.length) return statements
  if (!draft.original) {
    return statements.map((s) => (/^CREATE TABLE\b/.test(s) ? `${s} ${clauses.join(' ')}` : s))
  }
  if (!original) return statements
  const table = qualified('mysql', { schema: draft.schema, name: draft.original.name })
  const alter = `ALTER TABLE ${table}\n  ${clauses.join(',\n  ')}`
  const rename = statements.findIndex((s) => /^RENAME TABLE\b/.test(s))
  return rename < 0
    ? [...statements, alter]
    : [...statements.slice(0, rename), alter, ...statements.slice(rename)]
}

export interface OptionsContext {
  engines: StorageEngine[]
  /** The table's options as loaded; null when creating one */
  original: TableOptions | null
  /** Foreign keys in other tables that reference this one */
  inbound: InboundKey[]
}

const liveForeignKeys = (draft: TableDraft) => draft.foreignKeys.filter((fk) => !fk.dropped)
const fullTextIndexes = (draft: TableDraft) =>
  draft.indexes.filter((ix) => !ix.dropped && ix.method.toUpperCase() === 'FULLTEXT')
const listed = (names: string[]): string => names.join(', ')

/** The first table option problem that would make the script fail, or null. */
export function tableOptionProblem(
  draft: TableDraft,
  options: TableOptions,
  context: OptionsContext
): string | null {
  const { engines, original } = context
  const engine = effectiveEngine(options.engine, engines)
  const traits = engineTraits(engine, engines)
  const fks = liveForeignKeys(draft)
  if (traits.foreignKeys === 'rejected' && fks.length)
    return `${engine} doesn't support foreign keys; drop ${listed(fks.map((fk) => foreignKeyName(draft, fk)))}`
  const fullText = fullTextIndexes(draft)
  if (!traits.fullText && fullText.length)
    return `${engine} doesn't support FULLTEXT indexes like ${listed(fullText.map((ix) => indexName(draft, ix)))}`
  if (original && draft.original && options.engine !== original.engine) {
    const from = engineTraits(original.engine, engines)
    // The server refuses to move a table that has (or gets) foreign keys off InnoDB
    if (from.foreignKeys === 'enforced' && traits.foreignKeys !== 'enforced') {
      if (fks.length)
        return `Drop foreign keys ${listed(fks.map((fk) => foreignKeyName(draft, fk)))} first: a table with foreign keys can't change to ${engine}`
      if (context.inbound.length)
        return `Referenced by ${listed(context.inbound.map((k) => `${k.table}.${k.name}`))}; drop those foreign keys before changing to ${engine}`
    }
  }
  return null
}

/** Table option consequences worth a second look before applying. */
export function tableOptionWarnings(
  draft: TableDraft,
  options: TableOptions,
  context: OptionsContext
): string[] {
  const { engines, original } = context
  const engine = effectiveEngine(options.engine, engines)
  const traits = engineTraits(engine, engines)
  const warnings: string[] = []
  const existing = !!draft.original && !!original
  const engineChanged = existing && options.engine !== original!.engine
  if (engineChanged)
    warnings.push(`Changing the engine to ${engine} rebuilds the table, copying every row`)
  else if (existing && options.rowFormat !== original!.rowFormat)
    warnings.push('Changing the row format rebuilds the table, copying every row')
  const wasTransactional = existing ? engineTraits(original!.engine, engines).transactional : true
  if (!traits.transactional && (engineChanged || !existing) && wasTransactional && options.engine)
    warnings.push(`${engine} has no transactions or foreign keys: writes can't be rolled back`)
  const fks = liveForeignKeys(draft)
  if (traits.foreignKeys === 'ignored' && fks.length)
    warnings.push(
      `${engine} won't enforce foreign ${fks.length === 1 ? 'key' : 'keys'} ${listed(fks.map((fk) => foreignKeyName(draft, fk)))}; the server accepts and ignores ${fks.length === 1 ? 'it' : 'them'}`
    )
  const columns = draft.columns.filter((c) => !c.dropped)
  if (!traits.blobs) {
    const blobs = columns.filter((c) => /text|blob|json/i.test(c.dataType))
    if (blobs.length)
      warnings.push(
        `${engine} has no TEXT / BLOB columns, so ${listed(blobs.map((c) => c.name.trim()))} ${blobs.length === 1 ? 'fails' : 'fail'}`
      )
  }
  if (!traits.nullable && columns.some((c) => c.nullable))
    warnings.push(`${engine} needs every column NOT NULL`)
  if (!traits.indexes && (draft.primaryKey.length || draft.indexes.some((ix) => !ix.dropped)))
    warnings.push(`${engine} doesn't support indexes or primary keys`)
  return warnings
}
