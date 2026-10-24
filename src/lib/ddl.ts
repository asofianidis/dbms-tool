import type { ColumnInfo, ForeignKeyInfo, IndexInfo, TableInfo } from './api'
import type { Dialect } from './engines'
import { retargetDefinition, type SqliteTableShape } from './sqlite-schema'
import { isNumericType, literal, qualified, quoteIdent } from './sql'
import type { TableExtras } from './table-extras'

/* ---------- Table designer drafts ---------- */

export interface ColumnState {
  name: string
  dataType: string
  nullable: boolean
  /** SQL expression, '' for none */
  default: string
  identity: boolean
  comment: string
}

export interface ColumnDraft extends ColumnState {
  id: string
  /** The column as loaded; null for a new column */
  original: ColumnState | null
  /** Computed / generated columns can be dropped but not altered */
  computed: boolean
  /** MySQL `ON UPDATE` expression a MODIFY COLUMN has to restate */
  onUpdate: string | null
  dropped: boolean
}

export interface IndexState {
  name: string
  /** Column draft ids, in key order */
  columns: string[]
  unique: boolean
  /** Covering (INCLUDE) column draft ids */
  include: string[]
  /** Partial index predicate, '' for none */
  where: string
  /** Access method or index kind from indexMethods(), '' for the default */
  method: string
}

export interface IndexDraft extends IndexState {
  id: string
  /** The index as loaded; null for a new index */
  original: IndexInfo | null
  /** Its state as loaded, which edits are compared against */
  initial: IndexState | null
  /**
   * Why an existing index can only be dropped (expression keys, sort orders,
   * kinds the designer can't write), or null
   */
  locked: string | null
  dropped: boolean
}

export type ForeignKeyAction = 'NO ACTION' | 'RESTRICT' | 'CASCADE' | 'SET NULL' | 'SET DEFAULT'

export interface ForeignKeyState {
  name: string
  /** Column draft ids */
  columns: string[]
  refSchema: string | null
  refTable: string
  refColumns: string[]
  onDelete: ForeignKeyAction
  onUpdate: ForeignKeyAction
}

export interface ForeignKeyDraft extends ForeignKeyState {
  id: string
  /** The constraint as loaded; null for a new one */
  original: ForeignKeyInfo | null
  initial: ForeignKeyState | null
  dropped: boolean
}

export interface CheckState {
  /** '' for an unnamed SQLite constraint, or a new one named after the table */
  name: string
  expression: string
}

export interface CheckDraft extends CheckState {
  id: string
  /** The constraint as loaded; null for a new one */
  initial: CheckState | null
  dropped: boolean
}

export interface UniqueState {
  name: string
  /** Column draft ids */
  columns: string[]
}

export interface UniqueDraft extends UniqueState {
  id: string
  /** The constraint as loaded; null for a new one */
  initial: UniqueState | null
  dropped: boolean
}

export interface TableDraft {
  /** Schema (PostgreSQL / SQL Server) or database (MySQL); null on SQLite */
  schema: string | null
  name: string
  columns: ColumnDraft[]
  /** Column draft ids, in key order */
  primaryKey: string[]
  indexes: IndexDraft[]
  foreignKeys: ForeignKeyDraft[]
  checks: CheckDraft[]
  uniques: UniqueDraft[]
  /** The table as loaded; null when creating one */
  original: {
    name: string
    primaryKey: string[]
    primaryKeyName: string | null
    /** SQLite: what a rebuild carries over from the old table */
    sqlite?: { shape: SqliteTableShape | null; triggers: string[] }
  } | null
}

let seq = 0
export const draftId = (): string => `d${++seq}`

export function foreignKeyActions(dialect: Dialect): ForeignKeyAction[] {
  switch (dialect) {
    case 'postgres':
      return ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT']
    case 'mysql':
      // InnoDB rejects SET DEFAULT
      return ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL']
    case 'tsql':
      return ['NO ACTION', 'CASCADE', 'SET NULL', 'SET DEFAULT']
    case 'sqlite':
      return ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT']
  }
}

/** Index methods the designer can write; the first is each engine's default. */
export function indexMethods(dialect: Dialect): string[] {
  switch (dialect) {
    case 'postgres':
      return ['btree', 'hash', 'gist', 'spgist', 'gin', 'brin']
    case 'mysql':
      return ['BTREE', 'HASH', 'FULLTEXT', 'SPATIAL']
    case 'tsql':
      return ['NONCLUSTERED', 'CLUSTERED']
    case 'sqlite':
      return []
  }
}

/** Which index options an engine has. */
export function indexFeatures(dialect: Dialect): { include: boolean; where: boolean } {
  return {
    include: dialect === 'postgres' || dialect === 'tsql',
    where: dialect !== 'mysql'
  }
}

/** '' for the default method, otherwise the method as indexMethods() spells it. */
function normMethod(dialect: Dialect, method: string | null): string {
  const methods = indexMethods(dialect)
  const found = methods.find((m) => m.toLowerCase() === (method ?? '').trim().toLowerCase())
  if (found === undefined) return (method ?? '').trim()
  return found === methods[0] ? '' : found
}

export function newColumn(dialect: Dialect, patch: Partial<ColumnState> = {}): ColumnDraft {
  return {
    id: draftId(),
    original: null,
    name: '',
    dataType:
      dialect === 'tsql'
        ? 'nvarchar(255)'
        : dialect === 'mysql'
          ? 'varchar(255)'
          : dialect === 'sqlite'
            ? 'TEXT'
            : 'text',
    nullable: true,
    default: '',
    identity: false,
    comment: '',
    computed: false,
    onUpdate: null,
    dropped: false,
    ...patch
  }
}

export function newIndex(patch: Partial<IndexState> = {}): IndexDraft {
  return {
    id: draftId(),
    original: null,
    initial: null,
    locked: null,
    name: '',
    columns: [],
    unique: false,
    include: [],
    where: '',
    method: '',
    dropped: false,
    ...patch
  }
}

export function newForeignKey(patch: Partial<ForeignKeyState> = {}): ForeignKeyDraft {
  return {
    id: draftId(),
    original: null,
    initial: null,
    name: '',
    columns: [],
    refSchema: null,
    refTable: '',
    refColumns: [],
    onDelete: 'NO ACTION',
    onUpdate: 'NO ACTION',
    dropped: false,
    ...patch
  }
}

export function newCheck(patch: Partial<CheckState> = {}): CheckDraft {
  return { id: draftId(), initial: null, name: '', expression: '', dropped: false, ...patch }
}

export function newUnique(patch: Partial<UniqueState> = {}): UniqueDraft {
  return { id: draftId(), initial: null, name: '', columns: [], dropped: false, ...patch }
}

/** A new table with an identity primary key to start from. */
export function newTableDraft(dialect: Dialect, schema: string | null): TableDraft {
  const id = newColumn(dialect, {
    name: 'id',
    dataType: dialect === 'tsql' ? 'int' : dialect === 'sqlite' ? 'INTEGER' : 'bigint',
    nullable: false,
    // An INTEGER PRIMARY KEY is already SQLite's auto-assigned rowid
    identity: dialect !== 'sqlite'
  })
  return {
    schema,
    name: '',
    columns: [id],
    primaryKey: [id.id],
    indexes: [],
    foreignKeys: [],
    checks: [],
    uniques: [],
    original: null
  }
}

/**
 * MySQL 8 reports literal defaults unquoted (`abc`, `0`) and expression
 * defaults bare (`uuid()`); MariaDB quotes literals. Normalises both to the
 * SQL a column definition takes.
 */
export function mysqlDefaultExpr(raw: string | null, dataType: string): string {
  if (raw === null || /^null$/i.test(raw)) return ''
  if (/^'.*'$/s.test(raw) || /^b'[01]*'$/i.test(raw)) return raw
  if (/^(current_timestamp|now|localtime|localtimestamp)(\(\d*\))?$/i.test(raw)) return raw
  if (isNumericType(dataType) && /^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(raw)) return raw
  // MySQL 8 escapes quotes inside expressions: lower(_latin1\'A\')
  if (/^[a-z_][a-z0-9_]*\(.*\)$/is.test(raw)) return `(${raw.replace(/\\'/g, "'")})`
  return literal('mysql', raw)
}

function isComputed(dialect: Dialect, c: ColumnInfo): boolean {
  // MySQL flags expression defaults as DEFAULT_GENERATED; only VIRTUAL / STORED columns are computed
  if (dialect === 'mysql') return /\b(virtual|stored) generated\b/i.test(c.extra ?? '')
  // SQLite's table_info leaves generated columns out; its "generated" flag marks the rowid
  if (dialect === 'sqlite') return false
  // PostgreSQL serial columns are "generated" through a nextval() default
  return c.isGenerated && !c.isIdentity && !/^nextval\(/i.test(c.default ?? '')
}

const IDENT = /^\s*("(?:[^"]|"")+"|`[^`]+`|\[[^\]]+\]|[\w$]+)\s*$/

/** Why an existing index can't be rebuilt from its draft, or null. */
function indexLock(dialect: Dialect, ix: IndexInfo, columns: string[]): string | null {
  if (columns.some((id) => id.startsWith('?')) || !ix.columns.length)
    return 'Indexes on expressions can only be dropped here'
  const method = normMethod(dialect, ix.method)
  if (method && !indexMethods(dialect).includes(method))
    return `${ix.method} indexes can only be dropped here`
  // pg_get_indexdef / sqlite_master spell out sort orders, collations and operator classes
  const def = ix.definition ?? ''
  const on = def.search(/\sON\s/i)
  const open = on < 0 ? -1 : def.indexOf('(', on)
  if (open >= 0) {
    let depth = 0
    for (let i = open; i < def.length; i++) {
      if (def[i] === '(') depth++
      else if (def[i] === ')' && --depth === 0) {
        const keys = def.slice(open + 1, i).split(',')
        if (keys.some((k) => !IDENT.test(k)))
          return 'Indexes with sort orders, collations or operator classes can only be dropped here'
        break
      }
    }
  }
  return null
}

export function draftFromTable(
  dialect: Dialect,
  schema: string | null,
  name: string,
  info: TableInfo,
  extras?: TableExtras
): TableDraft {
  const shape = extras?.sqlite ?? null
  const columns = info.columns.map((c): ColumnDraft => {
    const key = info.primaryKey.includes(c.name)
    const state: ColumnState = {
      name: c.name,
      dataType: c.dataType,
      // SQLite key columns may be declared nullable; the designer writes them NOT NULL
      nullable: c.nullable && !(dialect === 'sqlite' && key),
      default:
        dialect === 'mysql' ? mysqlDefaultExpr(c.default, c.dataType) : (c.default ?? '').trim(),
      // SQLite's rowid is automatic; only AUTOINCREMENT is worth a checkbox
      identity:
        dialect === 'sqlite' && shape
          ? !!shape.columns[c.name.toLowerCase()]?.autoincrement
          : c.isIdentity,
      comment: c.comment ?? ''
    }
    return {
      ...state,
      id: draftId(),
      original: state,
      computed: isComputed(dialect, c),
      onUpdate: c.extra?.match(/\bon update (\S+)/i)?.[1] ?? null,
      dropped: false
    }
  })
  const idOf = (column: string): string =>
    columns.find((c) => c.name === column)?.id ?? `?${column}`
  const primaryKey = info.primaryKey.map(idOf)
  const constraintIndexes = new Set(extras?.uniques.map((u) => u.index) ?? [])
  return {
    schema,
    name,
    columns,
    primaryKey,
    indexes: info.indexes
      .filter(
        (ix) =>
          !ix.primary &&
          !constraintIndexes.has(ix.name) &&
          !(dialect === 'sqlite' && /^sqlite_autoindex_/.test(ix.name))
      )
      .map((ix) => {
        const detail = extras?.indexes.find((d) => d.name === ix.name)
        const state: IndexState = {
          name: ix.name,
          columns: ix.columns.map(idOf),
          unique: ix.unique,
          include: detail?.include.map(idOf) ?? [],
          where: detail?.where?.trim() ?? '',
          method: normMethod(dialect, ix.method)
        }
        return {
          ...state,
          id: draftId(),
          original: ix,
          initial: state,
          locked: indexLock(dialect, ix, state.columns),
          dropped: false
        }
      }),
    foreignKeys: info.foreignKeys.map((fk) => {
      const state: ForeignKeyState = {
        name: fk.name,
        columns: fk.columns.map(idOf),
        refSchema: fk.refSchema,
        refTable: fk.refTable,
        refColumns: fk.refColumns,
        onDelete: (fk.onDelete ?? 'NO ACTION') as ForeignKeyAction,
        onUpdate: (fk.onUpdate ?? 'NO ACTION') as ForeignKeyAction
      }
      return { ...state, id: draftId(), original: fk, initial: state, dropped: false }
    }),
    checks: (extras?.checks ?? []).map((c) => {
      const state: CheckState = { name: c.name ?? '', expression: c.expression }
      return { ...state, id: draftId(), initial: state, dropped: false }
    }),
    uniques: (extras?.uniques ?? []).map((u) => {
      const state: UniqueState = { name: u.name ?? '', columns: u.columns.map(idOf) }
      return { ...state, id: draftId(), initial: state, dropped: false }
    }),
    original: {
      name,
      primaryKey,
      primaryKeyName: info.indexes.find((ix) => ix.primary)?.name ?? null,
      ...(dialect === 'sqlite' && {
        sqlite: {
          shape,
          triggers: info.triggers.flatMap((t) => (t.definition ? [t.definition] : []))
        }
      })
    }
  }
}

/* ---------- Diffing ---------- */

const liveColumns = (draft: TableDraft): ColumnDraft[] => draft.columns.filter((c) => !c.dropped)

/** Primary key column ids, ignoring dropped columns. */
export function primaryKeyOf(draft: TableDraft): string[] {
  const live = new Set(liveColumns(draft).map((c) => c.id))
  return draft.primaryKey.filter((id) => live.has(id))
}

/** The column as it will be written: identity and key columns are NOT NULL, identities take no default. */
function effective(draft: TableDraft, c: ColumnState & { id?: string }): ColumnState {
  const key = c.id !== undefined && draft.primaryKey.includes(c.id)
  return {
    name: c.name.trim(),
    dataType: c.dataType.trim(),
    nullable: c.nullable && !c.identity && !key,
    default: c.identity ? '' : c.default.trim(),
    identity: c.identity,
    comment: c.comment.trim()
  }
}

const normType = (t: string): string => t.trim().replace(/\s+/g, ' ').toLowerCase()

interface ColumnDiff {
  renamed: boolean
  type: boolean
  nullable: boolean
  default: boolean
  identity: boolean
  comment: boolean
}

function diffColumn(draft: TableDraft, c: ColumnDraft): ColumnDiff | null {
  if (!c.original || c.dropped || c.computed) return null
  const now = effective(draft, c)
  const was = effective(draft, { ...c.original, id: undefined })
  // The original snapshot isn't tied to the current key, so compare its own nullability
  was.nullable = c.original.nullable
  const diff: ColumnDiff = {
    renamed: now.name !== was.name,
    type: normType(now.dataType) !== normType(was.dataType),
    nullable: now.nullable !== was.nullable,
    default: now.default !== was.default,
    identity: now.identity !== was.identity,
    comment: now.comment !== was.comment
  }
  return Object.values(diff).some(Boolean) ? diff : null
}

export function columnChanged(draft: TableDraft, c: ColumnDraft): boolean {
  return diffColumn(draft, c) !== null
}

const sameList = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i])

function primaryKeyChanged(draft: TableDraft): boolean {
  return !!draft.original && !sameList(primaryKeyOf(draft), draft.original.primaryKey)
}

/**
 * How an existing index or constraint changed: a new name alone can be renamed
 * in place (where the engine allows it), anything else drops and recreates it.
 */
export type Change = 'none' | 'rename' | 'recreate'

function change(sameShape: boolean, sameName: boolean, canRename: boolean): Change {
  if (!sameShape || (!sameName && !canRename)) return sameShape && sameName ? 'none' : 'recreate'
  return sameName ? 'none' : 'rename'
}

const renamesIndexes = (dialect: Dialect): boolean => dialect !== 'sqlite'
const renamesConstraints = (dialect: Dialect): boolean =>
  dialect === 'postgres' || dialect === 'tsql'

export function indexChange(dialect: Dialect, draft: TableDraft, ix: IndexDraft): Change {
  const was = ix.initial
  if (!ix.original || !was || ix.dropped) return 'none'
  const sameShape =
    sameList(ix.columns, was.columns) &&
    ix.unique === was.unique &&
    sameList(ix.include, was.include) &&
    ix.where.trim() === was.where &&
    normMethod(dialect, ix.method) === normMethod(dialect, was.method)
  return change(sameShape, indexName(draft, ix) === was.name, renamesIndexes(dialect))
}

export function foreignKeyChange(dialect: Dialect, draft: TableDraft, fk: ForeignKeyDraft): Change {
  const was = fk.initial
  if (!fk.original || !was || fk.dropped) return 'none'
  const sameShape =
    sameList(fk.columns, was.columns) &&
    (fk.refSchema ?? null) === (was.refSchema ?? null) &&
    fk.refTable === was.refTable &&
    sameList(fk.refColumns, was.refColumns) &&
    fk.onDelete === was.onDelete &&
    fk.onUpdate === was.onUpdate
  return change(sameShape, foreignKeyName(draft, fk) === was.name, renamesConstraints(dialect))
}

export function checkChange(dialect: Dialect, ck: CheckDraft): Change {
  const was = ck.initial
  if (!was || ck.dropped) return 'none'
  return change(
    ck.expression.trim() === was.expression.trim(),
    ck.name.trim() === was.name,
    renamesConstraints(dialect)
  )
}

export function uniqueChange(dialect: Dialect, uq: UniqueDraft): Change {
  const was = uq.initial
  if (!was || uq.dropped) return 'none'
  return change(
    sameList(uq.columns, was.columns),
    uq.name.trim() === was.name,
    renamesConstraints(dialect)
  )
}

/** Number of separate changes, for the dialog footer. */
export function countChanges(draft: TableDraft, dialect: Dialect = 'postgres'): number {
  if (!draft.original) return 0
  const edited = <T extends { dropped: boolean }>(
    items: T[],
    existing: (x: T) => boolean,
    changed: (x: T) => Change
  ): number =>
    items.filter((x) => (existing(x) ? x.dropped || changed(x) !== 'none' : !x.dropped)).length
  return (
    draft.columns.filter((c) => (c.original ? c.dropped || columnChanged(draft, c) : !c.dropped))
      .length +
    edited(
      draft.indexes,
      (ix) => !!ix.original,
      (ix) => indexChange(dialect, draft, ix)
    ) +
    edited(
      draft.foreignKeys,
      (fk) => !!fk.original,
      (fk) => foreignKeyChange(dialect, draft, fk)
    ) +
    edited(
      draft.checks,
      (ck) => !!ck.initial,
      (ck) => checkChange(dialect, ck)
    ) +
    edited(
      draft.uniques,
      (uq) => !!uq.initial,
      (uq) => uniqueChange(dialect, uq)
    ) +
    (primaryKeyChanged(draft) ? 1 : 0) +
    (draft.name.trim() !== draft.original.name ? 1 : 0)
  )
}

/* ---------- Validation ---------- */

/** The first problem that keeps the draft from being applied, or null. */
export function validateDraft(dialect: Dialect, draft: TableDraft): string | null {
  if (!draft.name.trim()) return 'Enter a table name'
  const live = liveColumns(draft)
  if (!live.length) return 'A table needs at least one column'
  const seen = new Set<string>()
  for (const c of live) {
    const name = c.name.trim()
    if (!name) return 'Every column needs a name'
    // SQLite columns may have no declared type
    if (!c.dataType.trim() && dialect !== 'sqlite') return `Column ${name} needs a type`
    if (seen.has(name.toLowerCase())) return `There are two columns named ${name}`
    seen.add(name.toLowerCase())
  }
  if (dialect !== 'postgres' && live.filter((c) => c.identity).length > 1)
    return 'A table can have only one identity column'
  if (dialect === 'sqlite') {
    const identity = live.find((c) => c.identity)
    const key = primaryKeyOf(draft)
    if (
      identity &&
      (key.length !== 1 || key[0] !== identity.id || !/^integer$/i.test(identity.dataType.trim()))
    )
      return `Only a lone INTEGER primary key can auto-increment, so ${identity.name.trim()} can't`
  }
  const liveIds = new Set(live.map((c) => c.id))
  const usesDropped = (ids: string[]): boolean =>
    ids.some((id) => !id.startsWith('?') && !liveIds.has(id))
  const rebuild = dialect === 'sqlite' && !!draft.original && needsRebuild(draft)
  // A SQLite rebuild recreates everything, so existing items get checked too
  const checked = <T extends { dropped: boolean }>(x: T, existing: boolean, c: () => Change) =>
    !x.dropped && (!existing || rebuild || c() !== 'none')

  for (const ix of draft.indexes) {
    if (!checked(ix, !!ix.original, () => indexChange(dialect, draft, ix))) continue
    if (!ix.columns.length) return `Pick the columns for index ${indexName(draft, ix)}`
    if (usesDropped(ix.columns) || usesDropped(ix.include))
      return `Index ${indexName(draft, ix)} uses a dropped column`
  }
  for (const fk of draft.foreignKeys) {
    if (!checked(fk, !!fk.original, () => foreignKeyChange(dialect, draft, fk))) continue
    const name = foreignKeyName(draft, fk)
    if (!fk.columns.length) return `Pick the columns for foreign key ${name}`
    if (usesDropped(fk.columns)) return `Foreign key ${name} uses a dropped column`
    if (!fk.refTable) return `Pick the table foreign key ${name} references`
    if (fk.refColumns.length !== fk.columns.length)
      return `Foreign key ${name} needs as many referenced columns as columns`
  }
  for (const uq of draft.uniques) {
    if (!checked(uq, !!uq.initial, () => uniqueChange(dialect, uq))) continue
    const name = uniqueName(draft, uq)
    if (!uq.columns.length) return `Pick the columns for unique constraint ${name}`
    if (usesDropped(uq.columns)) return `Unique constraint ${name} uses a dropped column`
  }
  for (const ck of draft.checks) {
    if (!checked(ck, !!ck.initial, () => checkChange(dialect, ck))) continue
    if (!ck.expression.trim()) return `Enter the condition for check ${checkName(draft, ck)}`
  }
  if (rebuild) {
    const sqlite = draft.original!.sqlite
    if (!sqlite?.shape) return "Couldn't read the table's definition, which a rebuild needs"
    if (sqlite.shape.virtual) return "Virtual tables can't be changed here"
    if (Object.values(sqlite.shape.columns).some((c) => c.generated))
      return "Tables with generated columns can't be rebuilt here; only renames and new columns work"
  }
  return null
}

/** Changes worth a second look before applying (data loss, likely failures). */
export function draftWarnings(
  draft: TableDraft,
  dialect: Dialect = 'postgres',
  options: DdlOptions = {}
): string[] {
  if (!draft.original) return []
  const warnings: string[] = []
  const dropped = draft.columns.filter((c) => c.original && c.dropped)
  if (dropped.length)
    warnings.push(
      `Drops ${dropped.length === 1 ? 'column' : 'columns'} ${dropped.map((c) => c.original!.name).join(', ')} and ${dropped.length === 1 ? 'its' : 'their'} data`
    )
  for (const c of draft.columns) {
    if (diffColumn(draft, c)?.type)
      warnings.push(`Changes the type of ${c.name.trim()}; existing values must convert`)
    const now = effective(draft, c)
    if (!c.original && !c.dropped && !now.nullable && !now.default && !now.identity)
      warnings.push(
        `New NOT NULL column ${now.name || '(unnamed)'} has no default; fails if the table has rows`
      )
  }
  const added = [
    ...draft.checks
      .filter((ck) => !ck.dropped && (!ck.initial || checkChange(dialect, ck) === 'recreate'))
      .map((ck) => checkName(draft, ck)),
    ...draft.uniques
      .filter((uq) => !uq.dropped && (!uq.initial || uniqueChange(dialect, uq) === 'recreate'))
      .map((uq) => uniqueName(draft, uq))
  ]
  if (added.length)
    warnings.push(
      `${added.join(', ')} ${added.length === 1 ? 'fails' : 'fail'} if existing rows break ${added.length === 1 ? 'it' : 'them'}`
    )
  if (dialect === 'sqlite' && needsRebuild(draft)) {
    warnings.push(
      'Rebuilds the table: copies its rows into a new table, then recreates its indexes and triggers'
    )
    if (options.d1)
      warnings.push(
        'D1 enforces foreign keys, so rows that reference this table with ON DELETE CASCADE are deleted'
      )
  }
  return warnings
}

/* ---------- Statement generation ---------- */

export function indexName(draft: TableDraft, ix: IndexDraft): string {
  if (ix.name.trim()) return ix.name.trim()
  const columns = ix.columns.map((id) => columnName(draft, id)).join('_')
  return `${ix.unique ? 'ux' : 'ix'}_${draft.name.trim()}${columns ? `_${columns}` : ''}`
}

export function foreignKeyName(draft: TableDraft, fk: ForeignKeyDraft): string {
  if (fk.name.trim()) return fk.name.trim()
  const columns = fk.columns.map((id) => columnName(draft, id)).join('_')
  return `fk_${draft.name.trim()}${columns ? `_${columns}` : ''}`
}

export function uniqueName(draft: TableDraft, uq: UniqueDraft): string {
  if (uq.name.trim()) return uq.name.trim()
  if (uq.initial) return '(unnamed)'
  const columns = uq.columns.map((id) => columnName(draft, id)).join('_')
  return `uq_${draft.name.trim()}${columns ? `_${columns}` : ''}`
}

export function checkName(draft: TableDraft, ck: CheckDraft): string {
  if (ck.name.trim()) return ck.name.trim()
  if (ck.initial) return '(unnamed)'
  const n = draft.checks.filter((c) => !c.initial).indexOf(ck) + 1
  return `ck_${draft.name.trim()}_${n}`
}

function columnName(draft: TableDraft, id: string): string {
  // Unknown ids come from expression indexes and carry their raw text
  return draft.columns.find((c) => c.id === id)?.name.trim() ?? id.replace(/^\?/, '')
}

function columnList(dialect: Dialect, draft: TableDraft, ids: string[]): string {
  return ids.map((id) => quoteIdent(dialect, columnName(draft, id))).join(', ')
}

function columnDefinition(
  dialect: Dialect,
  c: ColumnState,
  onUpdate: string | null = null
): string {
  const parts = [quoteIdent(dialect, c.name), c.dataType]
  switch (dialect) {
    case 'postgres':
      if (c.identity) parts.push('GENERATED BY DEFAULT AS IDENTITY')
      if (!c.nullable) parts.push('NOT NULL')
      if (c.default) parts.push(`DEFAULT ${c.default}`)
      break
    case 'mysql':
      parts.push(c.nullable ? 'NULL' : 'NOT NULL')
      if (c.default) parts.push(`DEFAULT ${c.default}`)
      if (onUpdate) parts.push(`ON UPDATE ${onUpdate}`)
      if (c.identity) parts.push('AUTO_INCREMENT')
      if (c.comment) parts.push(`COMMENT ${literal(dialect, c.comment)}`)
      break
    case 'tsql':
      if (c.identity) parts.push('IDENTITY(1,1)')
      parts.push(c.nullable ? 'NULL' : 'NOT NULL')
      if (c.default) parts.push(`DEFAULT ${c.default}`)
      break
    case 'sqlite':
      // An auto-increment key is declared on the column (see sqliteColumn)
      if (!c.nullable && !c.identity) parts.push('NOT NULL')
      if (c.default) parts.push(`DEFAULT ${sqliteDefault(c.default)}`)
      break
  }
  return parts.filter(Boolean).join(' ')
}

/** SQLite wants anything but a literal or CURRENT_* default in parentheses. */
function sqliteDefault(expr: string): string {
  if (
    /^\(/.test(expr) ||
    /^[-+]?(\d|\.\d)/.test(expr) ||
    /^x?'/i.test(expr) ||
    /^(null|true|false|current_(time|date|timestamp))$/i.test(expr)
  )
    return expr
  return `(${expr})`
}

/** The SQLite column definition, with the key inline for an AUTOINCREMENT column. */
function sqliteColumn(draft: TableDraft, c: ColumnDraft): string {
  const now = effective(draft, c)
  let definition = columnDefinition('sqlite', now)
  if (now.identity) definition += ' PRIMARY KEY AUTOINCREMENT'
  const collate = c.original
    ? draft.original?.sqlite?.shape?.columns[c.original.name.toLowerCase()]?.collate
    : null
  if (collate) definition += ` COLLATE ${quoteIdent('sqlite', collate)}`
  return definition
}

export function foreignKeyClause(dialect: Dialect, draft: TableDraft, fk: ForeignKeyDraft): string {
  // A rebuilt SQLite table refers to itself under its new name
  const self =
    dialect === 'sqlite' && draft.original && fk.refTable === draft.original.name && !fk.refSchema
  const target = self
    ? quoteIdent(dialect, draft.name.trim())
    : qualified(dialect, { schema: fk.refSchema, name: fk.refTable })
  // SQLite reports no foreign key names, so loaded ones stay unnamed
  const unnamed =
    dialect === 'sqlite' && fk.original && foreignKeyName(draft, fk) === fk.original.name
  let clause = `${unnamed ? '' : `CONSTRAINT ${quoteIdent(dialect, foreignKeyName(draft, fk))} `}FOREIGN KEY (${columnList(
    dialect,
    draft,
    fk.columns
  )}) REFERENCES ${target} (${fk.refColumns.map((c) => quoteIdent(dialect, c)).join(', ')})`
  if (fk.onDelete !== 'NO ACTION') clause += ` ON DELETE ${fk.onDelete}`
  if (fk.onUpdate !== 'NO ACTION') clause += ` ON UPDATE ${fk.onUpdate}`
  return clause
}

function constraintPrefix(dialect: Dialect, name: string): string {
  return name === '(unnamed)' ? '' : `CONSTRAINT ${quoteIdent(dialect, name)} `
}

function uniqueClause(dialect: Dialect, draft: TableDraft, uq: UniqueDraft): string {
  return `${constraintPrefix(dialect, uniqueName(draft, uq))}UNIQUE (${columnList(dialect, draft, uq.columns)})`
}

function checkClause(dialect: Dialect, draft: TableDraft, ck: CheckDraft): string {
  return `${constraintPrefix(dialect, checkName(draft, ck))}CHECK (${ck.expression.trim()})`
}

function primaryKeyConstraint(dialect: Dialect, draft: TableDraft): string {
  // SQL Server would otherwise name it PK__table__<random>
  const name =
    dialect === 'tsql' ? `CONSTRAINT ${quoteIdent(dialect, `PK_${draft.name.trim()}`)} ` : ''
  return `${name}PRIMARY KEY (${columnList(dialect, draft, primaryKeyOf(draft))})`
}

/** Items to (re)create: new ones and existing ones that changed shape. */
const toCreate = <T extends { dropped: boolean }>(
  items: T[],
  existing: (x: T) => boolean,
  changed: (x: T) => Change
): T[] => items.filter((x) => !x.dropped && (!existing(x) || changed(x) === 'recreate'))

/** Existing items to drop: dropped ones and ones being recreated. */
const toDrop = <T extends { dropped: boolean }>(
  items: T[],
  existing: (x: T) => boolean,
  changed: (x: T) => Change
): T[] => items.filter((x) => existing(x) && (x.dropped || changed(x) === 'recreate'))

/** Index clause for MySQL's CREATE / ALTER TABLE. */
function mysqlIndexClause(draft: TableDraft, ix: IndexDraft): string {
  const method = normMethod('mysql', ix.method)
  const kind =
    method === 'FULLTEXT' || method === 'SPATIAL' ? `${method} ` : ix.unique ? 'UNIQUE ' : ''
  const using = method === 'HASH' ? ' USING HASH' : ''
  return `${kind}INDEX ${quoteIdent('mysql', indexName(draft, ix))} (${columnList('mysql', draft, ix.columns)})${using}`
}

function createIndex(dialect: Dialect, draft: TableDraft, table: string, ix: IndexDraft): string {
  const method = normMethod(dialect, ix.method)
  const kind = dialect === 'tsql' && method ? `${method} ` : ''
  const using = dialect === 'postgres' && method ? ` USING ${method}` : ''
  const features = indexFeatures(dialect)
  const include =
    features.include && ix.include.length
      ? ` INCLUDE (${columnList(dialect, draft, ix.include)})`
      : ''
  const where = features.where && ix.where.trim() ? ` WHERE ${ix.where.trim()}` : ''
  return `CREATE ${ix.unique ? 'UNIQUE ' : ''}${kind}INDEX ${quoteIdent(dialect, indexName(draft, ix))} ON ${table}${using} (${columnList(
    dialect,
    draft,
    ix.columns
  )})${include}${where}`
}

function commentOn(dialect: Dialect, table: string, column: string, comment: string): string {
  return `COMMENT ON COLUMN ${table}.${quoteIdent(dialect, column)} IS ${comment ? literal(dialect, comment) : 'NULL'}`
}

export interface DdlOptions {
  /** Babelfish keeps T-SQL defaults as PostgreSQL column defaults, not droppable constraints */
  babelfish?: boolean
  /** Cloudflare D1 runs a script as one atomic batch and rejects BEGIN / COMMIT */
  d1?: boolean
}

/** Statements (without trailing semicolons) that create or alter the table to match the draft. */
export function tableStatements(
  dialect: Dialect,
  draft: TableDraft,
  options: DdlOptions = {}
): string[] {
  if (!draft.original) return createStatements(dialect, draft)
  return dialect === 'sqlite'
    ? sqliteAlterStatements(draft, options)
    : alterStatements(dialect, draft, options)
}

/** Lines of a CREATE TABLE body after the columns: key, constraints, foreign keys. */
function tableConstraints(dialect: Dialect, draft: TableDraft): string[] {
  const lines: string[] = []
  const inlineKey = dialect === 'sqlite' && liveColumns(draft).some((c) => c.identity)
  if (primaryKeyOf(draft).length && !inlineKey) lines.push(primaryKeyConstraint(dialect, draft))
  for (const uq of draft.uniques) if (!uq.dropped) lines.push(uniqueClause(dialect, draft, uq))
  for (const ck of draft.checks) if (!ck.dropped) lines.push(checkClause(dialect, draft, ck))
  // MySQL takes indexes inline so the whole table is one statement
  if (dialect === 'mysql') {
    for (const ix of draft.indexes) if (!ix.dropped) lines.push(mysqlIndexClause(draft, ix))
  }
  for (const fk of draft.foreignKeys)
    if (!fk.dropped) lines.push(foreignKeyClause(dialect, draft, fk))
  return lines
}

function createStatements(dialect: Dialect, draft: TableDraft): string[] {
  const table = qualified(dialect, { schema: draft.schema, name: draft.name.trim() })
  const columns = liveColumns(draft)
  const lines = columns.map((c) =>
    dialect === 'sqlite'
      ? `  ${sqliteColumn(draft, c)}`
      : `  ${columnDefinition(dialect, effective(draft, c), c.onUpdate)}`
  )
  lines.push(...tableConstraints(dialect, draft).map((l) => `  ${l}`))
  const statements = [`CREATE TABLE ${table} (\n${lines.join(',\n')}\n)`]
  if (dialect !== 'mysql') {
    for (const ix of draft.indexes)
      if (!ix.dropped) statements.push(createIndex(dialect, draft, table, ix))
  }
  if (dialect === 'postgres') {
    for (const c of columns.map((c) => effective(draft, c)))
      if (c.comment) statements.push(commentOn(dialect, table, c.name, c.comment))
  }
  return statements
}

/** N'…' string literal for T-SQL system procedure arguments. */
const nstr = (s: string): string => `N'${s.replace(/'/g, "''")}'`

/** Drops a column's default constraint, whatever SQL Server named it. */
function dropDefaultConstraint(table: string, column: string): string {
  return `DECLARE @sql nvarchar(max) = (
  SELECT N'ALTER TABLE ${table.replace(/'/g, "''")} DROP CONSTRAINT ' + QUOTENAME(d.name)
  FROM sys.default_constraints d
  JOIN sys.columns c ON c.object_id = d.parent_object_id AND c.column_id = d.parent_column_id
  WHERE d.parent_object_id = OBJECT_ID(${nstr(table)}) AND c.name = ${nstr(column)}
);
IF @sql IS NOT NULL EXEC (@sql)`
}

/** Existing and changed indexes and constraints, sorted by what happens to them. */
function plan(dialect: Dialect, draft: TableDraft) {
  const ixChange = (ix: IndexDraft) => indexChange(dialect, draft, ix)
  const fkChange = (fk: ForeignKeyDraft) => foreignKeyChange(dialect, draft, fk)
  const ckChange = (ck: CheckDraft) => checkChange(dialect, ck)
  const uqChange = (uq: UniqueDraft) => uniqueChange(dialect, uq)
  const isIndex = (ix: IndexDraft) => !!ix.original
  const isFk = (fk: ForeignKeyDraft) => !!fk.original
  const isCheck = (ck: CheckDraft) => !!ck.initial
  const isUnique = (uq: UniqueDraft) => !!uq.initial
  return {
    dropIndexes: toDrop(draft.indexes, isIndex, ixChange),
    createIndexes: toCreate(draft.indexes, isIndex, ixChange),
    renameIndexes: draft.indexes.filter((ix) => ixChange(ix) === 'rename'),
    dropForeignKeys: toDrop(draft.foreignKeys, isFk, fkChange),
    recreatedForeignKeys: draft.foreignKeys.filter((fk) => fkChange(fk) === 'recreate'),
    createForeignKeys: toCreate(draft.foreignKeys, isFk, fkChange),
    renameForeignKeys: draft.foreignKeys.filter((fk) => fkChange(fk) === 'rename'),
    dropChecks: toDrop(draft.checks, isCheck, ckChange),
    recreatedChecks: draft.checks.filter((ck) => ckChange(ck) === 'recreate'),
    createChecks: toCreate(draft.checks, isCheck, ckChange),
    renameChecks: draft.checks.filter((ck) => ckChange(ck) === 'rename'),
    dropUniques: toDrop(draft.uniques, isUnique, uqChange),
    createUniques: toCreate(draft.uniques, isUnique, uqChange),
    renameUniques: draft.uniques.filter((uq) => uqChange(uq) === 'rename')
  }
}

function alterStatements(dialect: Dialect, draft: TableDraft, options: DdlOptions): string[] {
  const original = draft.original!
  // SQL Server can't drop or alter a column that has a default constraint; Babelfish can
  const constrainedDefaults = dialect === 'tsql' && !options.babelfish
  const table = qualified(dialect, { schema: draft.schema, name: original.name })
  const q = (name: string): string => quoteIdent(dialect, name)
  const pkChanged = primaryKeyChanged(draft)
  const p = plan(dialect, draft)
  const droppedColumns = draft.columns.filter((c) => c.original && c.dropped)
  const addedColumns = draft.columns.filter((c) => !c.original && !c.dropped)
  const newName = draft.name.trim()

  if (dialect === 'mysql') {
    // One ALTER TABLE: MySQL DDL isn't transactional, but a single statement is atomic.
    // Constraints recreated under the same name have to be dropped by an earlier one.
    const before: string[] = [
      ...p.recreatedForeignKeys.map((fk) => `DROP FOREIGN KEY ${q(fk.initial!.name)}`),
      ...p.recreatedChecks.map((ck) => `DROP CONSTRAINT ${q(ck.initial!.name)}`)
    ]
    const clauses: string[] = [
      ...p.dropForeignKeys
        .filter((fk) => fk.dropped)
        .map((fk) => `DROP FOREIGN KEY ${q(fk.original!.name)}`),
      ...p.dropChecks
        .filter((ck) => ck.dropped)
        .map((ck) => `DROP CONSTRAINT ${q(ck.initial!.name)}`),
      ...p.dropUniques.map((uq) => `DROP INDEX ${q(uq.initial!.name)}`),
      ...p.dropIndexes.map((ix) => `DROP INDEX ${q(ix.original!.name)}`),
      ...p.renameIndexes.map(
        (ix) => `RENAME INDEX ${q(ix.initial!.name)} TO ${q(indexName(draft, ix))}`
      ),
      ...(pkChanged && original.primaryKey.length ? ['DROP PRIMARY KEY'] : []),
      ...droppedColumns.map((c) => `DROP COLUMN ${q(c.original!.name)}`)
    ]
    for (const c of draft.columns) {
      const diff = diffColumn(draft, c)
      if (!diff) continue
      const definition = columnDefinition(dialect, effective(draft, c), c.onUpdate)
      clauses.push(
        diff.renamed
          ? `CHANGE COLUMN ${q(c.original!.name)} ${definition}`
          : `MODIFY COLUMN ${definition}`
      )
    }
    for (const c of addedColumns)
      clauses.push(`ADD COLUMN ${columnDefinition(dialect, effective(draft, c))}`)
    if (pkChanged && primaryKeyOf(draft).length)
      clauses.push(`ADD PRIMARY KEY (${columnList(dialect, draft, primaryKeyOf(draft))})`)
    for (const uq of p.createUniques) clauses.push(`ADD ${uniqueClause(dialect, draft, uq)}`)
    for (const ck of p.createChecks) clauses.push(`ADD ${checkClause(dialect, draft, ck)}`)
    for (const ix of p.createIndexes) clauses.push(`ADD ${mysqlIndexClause(draft, ix)}`)
    for (const fk of p.createForeignKeys)
      clauses.push(`ADD ${foreignKeyClause(dialect, draft, fk)}`)
    const statements: string[] = []
    if (before.length) statements.push(`ALTER TABLE ${table}\n  ${before.join(',\n  ')}`)
    if (clauses.length) statements.push(`ALTER TABLE ${table}\n  ${clauses.join(',\n  ')}`)
    if (newName !== original.name)
      statements.push(
        `RENAME TABLE ${table} TO ${qualified(dialect, { schema: draft.schema, name: newName })}`
      )
    return statements
  }

  const out: string[] = []
  const alter = (clause: string): void => void out.push(`ALTER TABLE ${table} ${clause}`)
  const renameConstraint = (from: string, to: string): void => {
    if (dialect === 'postgres') alter(`RENAME CONSTRAINT ${q(from)} TO ${q(to)}`)
    else
      out.push(
        `EXEC sp_rename ${nstr(qualified(dialect, { schema: draft.schema, name: from }))}, ${nstr(to)}, 'OBJECT'`
      )
  }

  // Drop dependants before the columns they use
  for (const fk of p.dropForeignKeys) alter(`DROP CONSTRAINT ${q(fk.original!.name)}`)
  for (const ck of p.dropChecks) alter(`DROP CONSTRAINT ${q(ck.initial!.name)}`)
  for (const uq of p.dropUniques) alter(`DROP CONSTRAINT ${q(uq.initial!.name)}`)
  for (const ix of p.dropIndexes) {
    out.push(
      dialect === 'postgres'
        ? `DROP INDEX ${qualified(dialect, { schema: draft.schema, name: ix.original!.name })}`
        : `DROP INDEX ${q(ix.original!.name)} ON ${table}`
    )
  }
  for (const ix of p.renameIndexes) {
    out.push(
      dialect === 'postgres'
        ? `ALTER INDEX ${qualified(dialect, { schema: draft.schema, name: ix.initial!.name })} RENAME TO ${q(indexName(draft, ix))}`
        : `EXEC sp_rename ${nstr(`${table}.${q(ix.initial!.name)}`)}, ${nstr(indexName(draft, ix))}, 'INDEX'`
    )
  }
  for (const fk of p.renameForeignKeys)
    renameConstraint(fk.initial!.name, foreignKeyName(draft, fk))
  for (const ck of p.renameChecks) renameConstraint(ck.initial!.name, checkName(draft, ck))
  for (const uq of p.renameUniques) renameConstraint(uq.initial!.name, uniqueName(draft, uq))
  if (pkChanged && original.primaryKey.length) {
    const name = original.primaryKeyName ?? `${original.name}_pkey`
    alter(`DROP CONSTRAINT ${q(name)}`)
  }
  for (const c of droppedColumns) {
    if (constrainedDefaults && c.original!.default)
      out.push(dropDefaultConstraint(table, c.original!.name))
    alter(`DROP COLUMN ${q(c.original!.name)}`)
  }

  for (const c of draft.columns) {
    const diff = diffColumn(draft, c)
    if (!diff) continue
    const was = c.original!
    const now = effective(draft, c)
    const column = q(now.name)
    if (dialect === 'postgres') {
      if (diff.renamed) alter(`RENAME COLUMN ${q(was.name)} TO ${column}`)
      if (diff.type)
        alter(`ALTER COLUMN ${column} TYPE ${now.dataType} USING ${column}::${now.dataType}`)
      if (diff.identity && !now.identity) alter(`ALTER COLUMN ${column} DROP IDENTITY`)
      if (diff.default)
        alter(
          `ALTER COLUMN ${column} ${now.default ? `SET DEFAULT ${now.default}` : 'DROP DEFAULT'}`
        )
      if (diff.nullable) alter(`ALTER COLUMN ${column} ${now.nullable ? 'DROP' : 'SET'} NOT NULL`)
      if (diff.identity && now.identity)
        alter(`ALTER COLUMN ${column} ADD GENERATED BY DEFAULT AS IDENTITY`)
      if (diff.comment) out.push(commentOn(dialect, table, now.name, now.comment))
    } else {
      // SQL Server: drop the default constraint around the change and add it back
      const redefine = diff.type || diff.nullable
      const dropDefault = constrainedDefaults && !!was.default && (redefine || diff.default)
      if (dropDefault) out.push(dropDefaultConstraint(table, was.name))
      if (diff.renamed)
        out.push(`EXEC sp_rename ${nstr(`${table}.${q(was.name)}`)}, ${nstr(now.name)}, 'COLUMN'`)
      if (redefine)
        alter(`ALTER COLUMN ${column} ${now.dataType} ${now.nullable ? 'NULL' : 'NOT NULL'}`)
      // Babelfish replaces a default in place, and DEFAULT NULL is how it clears one
      const setDefault = constrainedDefaults
        ? (dropDefault || diff.default) && now.default
        : diff.default
      if (setDefault)
        alter(
          `ADD CONSTRAINT ${q(`DF_${original.name}_${now.name}`)} DEFAULT ${now.default || 'NULL'} FOR ${column}`
        )
    }
  }

  for (const c of addedColumns) {
    const now = effective(draft, c)
    alter(`ADD ${dialect === 'postgres' ? 'COLUMN ' : ''}${columnDefinition(dialect, now)}`)
    if (dialect === 'postgres' && now.comment)
      out.push(commentOn(dialect, table, now.name, now.comment))
  }
  if (pkChanged && primaryKeyOf(draft).length) alter(`ADD ${primaryKeyConstraint(dialect, draft)}`)
  for (const uq of p.createUniques) alter(`ADD ${uniqueClause(dialect, draft, uq)}`)
  for (const ck of p.createChecks) alter(`ADD ${checkClause(dialect, draft, ck)}`)
  for (const ix of p.createIndexes) out.push(createIndex(dialect, draft, table, ix))
  for (const fk of p.createForeignKeys) alter(`ADD ${foreignKeyClause(dialect, draft, fk)}`)

  if (newName !== original.name) {
    out.push(
      dialect === 'postgres'
        ? `ALTER TABLE ${table} RENAME TO ${q(newName)}`
        : `EXEC sp_rename ${nstr(table)}, ${nstr(newName)}, 'OBJECT'`
    )
  }
  return out
}

/* ---------- SQLite ---------- */

/** Whether SQLite can add the column with ALTER TABLE ADD COLUMN. */
function sqliteCanAdd(draft: TableDraft, c: ColumnDraft): boolean {
  const now = effective(draft, c)
  if (now.identity || draft.primaryKey.includes(c.id)) return false
  if (!now.nullable && !now.default) return false
  // ADD COLUMN takes no CURRENT_* or parenthesised default
  return !now.default || !/^(\(|current_(time|date|timestamp)$)/i.test(sqliteDefault(now.default))
}

/**
 * Whether the draft needs SQLite's table rebuild: ALTER TABLE only renames,
 * adds columns and (with restrictions this skips) drops them.
 */
export function needsRebuild(draft: TableDraft): boolean {
  if (!draft.original) return false
  const dialect: Dialect = 'sqlite'
  const p = plan(dialect, draft)
  return (
    draft.columns.some((c) => {
      const diff = diffColumn(draft, c)
      return (
        (c.original && c.dropped) ||
        (!!diff && (diff.type || diff.nullable || diff.default || diff.identity)) ||
        (!c.original && !c.dropped && !sqliteCanAdd(draft, c))
      )
    }) ||
    primaryKeyChanged(draft) ||
    p.dropForeignKeys.length + p.createForeignKeys.length > 0 ||
    p.dropChecks.length + p.createChecks.length > 0 ||
    p.dropUniques.length + p.createUniques.length > 0
  )
}

function sqliteAlterStatements(draft: TableDraft, options: DdlOptions): string[] {
  const dialect: Dialect = 'sqlite'
  const original = draft.original!
  const q = (name: string): string => quoteIdent(dialect, name)
  const table = q(original.name)
  const newName = draft.name.trim()
  const p = plan(dialect, draft)
  const out: string[] = []

  if (!needsRebuild(draft)) {
    for (const ix of p.dropIndexes) out.push(`DROP INDEX ${q(ix.original!.name)}`)
    for (const c of draft.columns) {
      if (diffColumn(draft, c)?.renamed)
        out.push(`ALTER TABLE ${table} RENAME COLUMN ${q(c.original!.name)} TO ${q(c.name.trim())}`)
    }
    for (const c of draft.columns)
      if (!c.original && !c.dropped)
        out.push(`ALTER TABLE ${table} ADD COLUMN ${sqliteColumn(draft, c)}`)
    for (const ix of p.createIndexes) out.push(createIndex(dialect, draft, table, ix))
    if (newName !== original.name) out.push(`ALTER TABLE ${table} RENAME TO ${q(newName)}`)
    return out
  }

  // The documented rebuild: create the new shape, copy the rows, swap the tables.
  // Foreign keys stay off so dropping the old table doesn't cascade; D1 keeps them
  // on and can only defer them. Legacy renames don't recheck views on the old table.
  const temp = q(`_${original.name}_rebuild`)
  const target = q(newName)
  out.push(options.d1 ? 'PRAGMA defer_foreign_keys = ON' : 'PRAGMA foreign_keys = OFF')
  out.push('PRAGMA legacy_alter_table = ON')
  const lines = [
    ...liveColumns(draft).map((c) => sqliteColumn(draft, c)),
    ...tableConstraints(dialect, draft)
  ]
  const tableOptions = original.sqlite?.shape?.options
  out.push(
    `CREATE TABLE ${temp} (\n${lines.map((l) => `  ${l}`).join(',\n')}\n)${tableOptions ? ` ${tableOptions}` : ''}`
  )
  const kept = liveColumns(draft).filter((c) => c.original)
  if (kept.length)
    out.push(
      `INSERT INTO ${temp} (${kept.map((c) => q(c.name.trim())).join(', ')})\n  SELECT ${kept
        .map((c) => q(c.original!.name))
        .join(', ')} FROM ${table}`
    )
  out.push(`DROP TABLE ${table}`)
  out.push(`ALTER TABLE ${temp} RENAME TO ${target}`)

  const renamed = new Set(
    draft.columns.filter((c) => diffColumn(draft, c)?.renamed).map((c) => c.id)
  )
  for (const ix of draft.indexes) {
    if (ix.dropped) continue
    const reuse =
      ix.original?.definition &&
      indexChange(dialect, draft, ix) === 'none' &&
      (ix.locked || ![...ix.columns, ...ix.include].some((id) => renamed.has(id)))
    out.push(
      reuse
        ? retargetDefinition(ix.original!.definition!, original.name, target).replace(/;\s*$/, '')
        : createIndex(dialect, draft, target, ix)
    )
  }
  for (const trigger of original.sqlite?.triggers ?? [])
    out.push(retargetDefinition(trigger, original.name, target).replace(/;\s*$/, ''))
  out.push('PRAGMA legacy_alter_table = OFF')
  return out
}

/**
 * Joins statements into a runnable script. T-SQL runs each statement as its
 * own batch inside a transaction that XACT_ABORT rolls back on failure;
 * PostgreSQL runs a multi-statement script in one implicit transaction;
 * SQLite gets an explicit one, with PRAGMAs (which don't work inside one)
 * around it. D1 runs every script as an atomic batch already.
 */
export function ddlScript(
  dialect: Dialect,
  statements: string[],
  options: DdlOptions = {}
): string {
  if (!statements.length) return ''
  if (dialect === 'tsql') {
    return [
      'SET XACT_ABORT ON;\nBEGIN TRANSACTION;',
      ...statements.map((s) => `${s};`),
      'COMMIT TRANSACTION;'
    ].join('\nGO\n')
  }
  if (dialect === 'sqlite' && !options.d1) {
    const pragma = (s: string): boolean => /^PRAGMA\b/i.test(s)
    const head = statements.findIndex((s) => !pragma(s))
    const tail = statements.length - [...statements].reverse().findIndex((s) => !pragma(s))
    return [
      ...statements.slice(0, head),
      'BEGIN',
      ...statements.slice(head, tail),
      'COMMIT',
      ...statements.slice(tail)
    ]
      .map((s) => `${s};`)
      .join('\n\n')
  }
  return statements.map((s) => `${s};`).join('\n\n')
}

/* ---------- Schema designer ---------- */

/** A schema (PostgreSQL / SQL Server) or database (MySQL). */
export interface SchemaState {
  name: string
  /** Owning role or principal (PostgreSQL / SQL Server) */
  owner: string
  /** PostgreSQL only */
  comment: string
  /** MySQL default character set and collation, '' for the server default */
  charset: string
  collation: string
}

export interface SchemaDraft extends SchemaState {
  /** The schema as loaded; null when creating one */
  original: SchemaState | null
}

export function newSchemaDraft(): SchemaDraft {
  return { name: '', owner: '', comment: '', charset: '', collation: '', original: null }
}

export function schemaDraftFrom(state: SchemaState): SchemaDraft {
  return { ...state, original: state }
}

/** Only PostgreSQL can rename a schema; SQL Server and MySQL can't rename schemas or databases. */
export const canRenameSchema = (dialect: Dialect): boolean => dialect === 'postgres'

/** Whether an existing schema's owner can change (Babelfish rejects ALTER AUTHORIZATION). */
export const canChangeSchemaOwner = (dialect: Dialect, options: DdlOptions = {}): boolean =>
  dialect === 'postgres' || (dialect === 'tsql' && !options.babelfish)

export function validateSchema(draft: SchemaDraft): string | null {
  if (!draft.name.trim()) return 'Enter a name'
  // Character sets and collations are spliced in unquoted
  if (!/^\w*$/.test(draft.charset) || !/^\w*$/.test(draft.collation))
    return 'Invalid character set or collation'
  return null
}

/** Statements (without trailing semicolons) that create or alter the schema to match the draft. */
export function schemaStatements(
  dialect: Dialect,
  draft: SchemaDraft,
  options: DdlOptions = {}
): string[] {
  const q = (name: string): string => quoteIdent(dialect, name)
  const name = draft.name.trim()
  const owner = draft.owner.trim()
  const comment = draft.comment.trim()
  const was = draft.original

  if (dialect === 'mysql') {
    const defaults = [
      draft.charset && `CHARACTER SET ${draft.charset}`,
      draft.collation && `COLLATE ${draft.collation}`
    ].filter(Boolean)
    if (!was) return [[`CREATE DATABASE ${q(name)}`, ...defaults].join(' ')]
    const changed = draft.charset !== was.charset || draft.collation !== was.collation
    return changed && defaults.length
      ? [[`ALTER DATABASE ${q(was.name)}`, ...defaults].join(' ')]
      : []
  }

  if (!was) {
    const statements = [`CREATE SCHEMA ${q(name)}${owner ? ` AUTHORIZATION ${q(owner)}` : ''}`]
    if (dialect === 'postgres' && comment)
      statements.push(`COMMENT ON SCHEMA ${q(name)} IS ${literal(dialect, comment)}`)
    return statements
  }

  const statements: string[] = []
  if (dialect === 'postgres') {
    if (name !== was.name) statements.push(`ALTER SCHEMA ${q(was.name)} RENAME TO ${q(name)}`)
    if (owner && owner !== was.owner)
      statements.push(`ALTER SCHEMA ${q(name)} OWNER TO ${q(owner)}`)
    if (comment !== was.comment.trim())
      statements.push(
        `COMMENT ON SCHEMA ${q(name)} IS ${comment ? literal(dialect, comment) : 'NULL'}`
      )
  } else if (owner && owner !== was.owner && canChangeSchemaOwner(dialect, options)) {
    statements.push(`ALTER AUTHORIZATION ON SCHEMA::${q(was.name)} TO ${q(owner)}`)
  }
  return statements
}

/** DROP SCHEMA (DROP DATABASE on MySQL); only PostgreSQL can cascade to the contents. */
export function dropSchemaStatement(dialect: Dialect, name: string, cascade: boolean): string {
  const target = quoteIdent(dialect, name)
  if (dialect === 'mysql') return `DROP DATABASE ${target}`
  return `DROP SCHEMA ${target}${dialect === 'postgres' && cascade ? ' CASCADE' : ''}`
}
