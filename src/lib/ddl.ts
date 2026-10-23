import type { ColumnInfo, ForeignKeyInfo, IndexInfo, TableInfo } from './api'
import type { Dialect } from './engines'
import { isNumericType, literal, qualified, quoteIdent } from './sql'

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

export interface IndexDraft {
  id: string
  /** The index as loaded; existing indexes can only be dropped */
  original: IndexInfo | null
  name: string
  /** Column draft ids, in key order */
  columns: string[]
  unique: boolean
  dropped: boolean
}

export type ForeignKeyAction = 'NO ACTION' | 'RESTRICT' | 'CASCADE' | 'SET NULL' | 'SET DEFAULT'

export interface ForeignKeyDraft {
  id: string
  /** The constraint as loaded; existing constraints can only be dropped */
  original: ForeignKeyInfo | null
  name: string
  /** Column draft ids */
  columns: string[]
  refSchema: string | null
  refTable: string
  refColumns: string[]
  onDelete: ForeignKeyAction
  onUpdate: ForeignKeyAction
  dropped: boolean
}

export interface TableDraft {
  /** Schema (PostgreSQL / SQL Server) or database (MySQL) */
  schema: string | null
  name: string
  columns: ColumnDraft[]
  /** Column draft ids, in key order */
  primaryKey: string[]
  indexes: IndexDraft[]
  foreignKeys: ForeignKeyDraft[]
  /** The table as loaded; null when creating one */
  original: { name: string; primaryKey: string[]; primaryKeyName: string | null } | null
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
  }
}

export function newColumn(dialect: Dialect, patch: Partial<ColumnState> = {}): ColumnDraft {
  return {
    id: draftId(),
    original: null,
    name: '',
    dataType: dialect === 'tsql' ? 'nvarchar(255)' : dialect === 'mysql' ? 'varchar(255)' : 'text',
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

/** A new table with an identity primary key to start from. */
export function newTableDraft(dialect: Dialect, schema: string | null): TableDraft {
  const id = newColumn(dialect, {
    name: 'id',
    dataType: dialect === 'tsql' ? 'int' : 'bigint',
    nullable: false,
    identity: true
  })
  return {
    schema,
    name: '',
    columns: [id],
    primaryKey: [id.id],
    indexes: [],
    foreignKeys: [],
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
  // PostgreSQL serial columns are "generated" through a nextval() default
  return c.isGenerated && !c.isIdentity && !/^nextval\(/i.test(c.default ?? '')
}

export function draftFromTable(
  dialect: Dialect,
  schema: string | null,
  name: string,
  info: TableInfo
): TableDraft {
  const columns = info.columns.map((c): ColumnDraft => {
    const state: ColumnState = {
      name: c.name,
      dataType: c.dataType,
      nullable: c.nullable,
      default:
        dialect === 'mysql' ? mysqlDefaultExpr(c.default, c.dataType) : (c.default ?? '').trim(),
      identity: c.isIdentity,
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
  return {
    schema,
    name,
    columns,
    primaryKey,
    indexes: info.indexes
      .filter((ix) => !ix.primary)
      .map((ix) => ({
        id: draftId(),
        original: ix,
        name: ix.name,
        columns: ix.columns.map(idOf),
        unique: ix.unique,
        dropped: false
      })),
    foreignKeys: info.foreignKeys.map((fk) => ({
      id: draftId(),
      original: fk,
      name: fk.name,
      columns: fk.columns.map(idOf),
      refSchema: fk.refSchema,
      refTable: fk.refTable,
      refColumns: fk.refColumns,
      onDelete: (fk.onDelete ?? 'NO ACTION') as ForeignKeyAction,
      onUpdate: (fk.onUpdate ?? 'NO ACTION') as ForeignKeyAction,
      dropped: false
    })),
    original: {
      name,
      primaryKey,
      primaryKeyName: info.indexes.find((ix) => ix.primary)?.name ?? null
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

/** Number of separate changes, for the dialog footer. */
export function countChanges(draft: TableDraft): number {
  if (!draft.original) return 0
  return (
    draft.columns.filter((c) => (c.original ? c.dropped || columnChanged(draft, c) : !c.dropped))
      .length +
    draft.indexes.filter((ix) => (ix.original ? ix.dropped : !ix.dropped)).length +
    draft.foreignKeys.filter((fk) => (fk.original ? fk.dropped : !fk.dropped)).length +
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
    if (!c.dataType.trim()) return `Column ${name} needs a type`
    if (seen.has(name.toLowerCase())) return `There are two columns named ${name}`
    seen.add(name.toLowerCase())
  }
  if (dialect !== 'postgres' && live.filter((c) => c.identity).length > 1)
    return 'A table can have only one identity column'
  const liveIds = new Set(live.map((c) => c.id))
  for (const ix of draft.indexes) {
    if (ix.original || ix.dropped) continue
    if (!ix.columns.length) return `Pick the columns for index ${indexName(draft, ix)}`
    if (ix.columns.some((id) => !liveIds.has(id)))
      return `Index ${indexName(draft, ix)} uses a dropped column`
  }
  for (const fk of draft.foreignKeys) {
    if (fk.original || fk.dropped) continue
    const name = foreignKeyName(draft, fk)
    if (!fk.columns.length) return `Pick the columns for foreign key ${name}`
    if (fk.columns.some((id) => !liveIds.has(id)))
      return `Foreign key ${name} uses a dropped column`
    if (!fk.refTable) return `Pick the table foreign key ${name} references`
    if (fk.refColumns.length !== fk.columns.length)
      return `Foreign key ${name} needs as many referenced columns as columns`
  }
  return null
}

/** Changes worth a second look before applying (data loss, likely failures). */
export function draftWarnings(draft: TableDraft): string[] {
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
  }
  return parts.join(' ')
}

function foreignKeyClause(dialect: Dialect, draft: TableDraft, fk: ForeignKeyDraft): string {
  const target = qualified(dialect, { schema: fk.refSchema, name: fk.refTable })
  let clause = `CONSTRAINT ${quoteIdent(dialect, foreignKeyName(draft, fk))} FOREIGN KEY (${columnList(
    dialect,
    draft,
    fk.columns
  )}) REFERENCES ${target} (${fk.refColumns.map((c) => quoteIdent(dialect, c)).join(', ')})`
  if (fk.onDelete !== 'NO ACTION') clause += ` ON DELETE ${fk.onDelete}`
  if (fk.onUpdate !== 'NO ACTION') clause += ` ON UPDATE ${fk.onUpdate}`
  return clause
}

function primaryKeyConstraint(dialect: Dialect, draft: TableDraft): string {
  // SQL Server would otherwise name it PK__table__<random>
  const name =
    dialect === 'tsql' ? `CONSTRAINT ${quoteIdent(dialect, `PK_${draft.name.trim()}`)} ` : ''
  return `${name}PRIMARY KEY (${columnList(dialect, draft, primaryKeyOf(draft))})`
}

const newIndexes = (draft: TableDraft): IndexDraft[] =>
  draft.indexes.filter((ix) => !ix.original && !ix.dropped)
const newForeignKeys = (draft: TableDraft): ForeignKeyDraft[] =>
  draft.foreignKeys.filter((fk) => !fk.original && !fk.dropped)

function createIndex(dialect: Dialect, draft: TableDraft, table: string, ix: IndexDraft): string {
  return `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdent(dialect, indexName(draft, ix))} ON ${table} (${columnList(
    dialect,
    draft,
    ix.columns
  )})`
}

function commentOn(dialect: Dialect, table: string, column: string, comment: string): string {
  return `COMMENT ON COLUMN ${table}.${quoteIdent(dialect, column)} IS ${comment ? literal(dialect, comment) : 'NULL'}`
}

export interface DdlOptions {
  /** Babelfish keeps T-SQL defaults as PostgreSQL column defaults, not droppable constraints */
  babelfish?: boolean
}

/** Statements (without trailing semicolons) that create or alter the table to match the draft. */
export function tableStatements(
  dialect: Dialect,
  draft: TableDraft,
  options: DdlOptions = {}
): string[] {
  return draft.original
    ? alterStatements(dialect, draft, options)
    : createStatements(dialect, draft)
}

function createStatements(dialect: Dialect, draft: TableDraft): string[] {
  const table = qualified(dialect, { schema: draft.schema, name: draft.name.trim() })
  const columns = liveColumns(draft).map((c) => ({ ...effective(draft, c), onUpdate: c.onUpdate }))
  const lines = columns.map((c) => `  ${columnDefinition(dialect, c, c.onUpdate)}`)
  if (primaryKeyOf(draft).length) lines.push(`  ${primaryKeyConstraint(dialect, draft)}`)
  // MySQL takes indexes inline so the whole table is one statement
  if (dialect === 'mysql') {
    for (const ix of newIndexes(draft))
      lines.push(
        `  ${ix.unique ? 'UNIQUE ' : ''}INDEX ${quoteIdent(dialect, indexName(draft, ix))} (${columnList(dialect, draft, ix.columns)})`
      )
  }
  for (const fk of newForeignKeys(draft)) lines.push(`  ${foreignKeyClause(dialect, draft, fk)}`)
  const statements = [`CREATE TABLE ${table} (\n${lines.join(',\n')}\n)`]
  if (dialect !== 'mysql') {
    for (const ix of newIndexes(draft)) statements.push(createIndex(dialect, draft, table, ix))
  }
  if (dialect === 'postgres') {
    for (const c of columns)
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

function alterStatements(dialect: Dialect, draft: TableDraft, options: DdlOptions): string[] {
  const original = draft.original!
  // SQL Server can't drop or alter a column that has a default constraint; Babelfish can
  const constrainedDefaults = dialect === 'tsql' && !options.babelfish
  const table = qualified(dialect, { schema: draft.schema, name: original.name })
  const q = (name: string): string => quoteIdent(dialect, name)
  const pkChanged = primaryKeyChanged(draft)
  const droppedForeignKeys = draft.foreignKeys.filter((fk) => fk.original && fk.dropped)
  const droppedIndexes = draft.indexes.filter((ix) => ix.original && ix.dropped)
  const droppedColumns = draft.columns.filter((c) => c.original && c.dropped)
  const addedColumns = draft.columns.filter((c) => !c.original && !c.dropped)
  const newName = draft.name.trim()

  if (dialect === 'mysql') {
    // One ALTER TABLE: MySQL DDL isn't transactional, but a single statement is atomic
    const clauses: string[] = [
      ...droppedForeignKeys.map((fk) => `DROP FOREIGN KEY ${q(fk.original!.name)}`),
      ...droppedIndexes.map((ix) => `DROP INDEX ${q(ix.original!.name)}`),
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
    for (const ix of newIndexes(draft))
      clauses.push(
        `ADD ${ix.unique ? 'UNIQUE ' : ''}INDEX ${q(indexName(draft, ix))} (${columnList(dialect, draft, ix.columns)})`
      )
    for (const fk of newForeignKeys(draft))
      clauses.push(`ADD ${foreignKeyClause(dialect, draft, fk)}`)
    const statements = clauses.length ? [`ALTER TABLE ${table}\n  ${clauses.join(',\n  ')}`] : []
    if (newName !== original.name)
      statements.push(
        `RENAME TABLE ${table} TO ${qualified(dialect, { schema: draft.schema, name: newName })}`
      )
    return statements
  }

  const out: string[] = []
  const alter = (clause: string): void => void out.push(`ALTER TABLE ${table} ${clause}`)

  // Drop dependants before the columns they use
  for (const fk of droppedForeignKeys) alter(`DROP CONSTRAINT ${q(fk.original!.name)}`)
  for (const ix of droppedIndexes) {
    out.push(
      dialect === 'postgres'
        ? `DROP INDEX ${qualified(dialect, { schema: draft.schema, name: ix.original!.name })}`
        : `DROP INDEX ${q(ix.original!.name)} ON ${table}`
    )
  }
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
  for (const ix of newIndexes(draft)) out.push(createIndex(dialect, draft, table, ix))
  for (const fk of newForeignKeys(draft)) alter(`ADD ${foreignKeyClause(dialect, draft, fk)}`)

  if (newName !== original.name) {
    out.push(
      dialect === 'postgres'
        ? `ALTER TABLE ${table} RENAME TO ${q(newName)}`
        : `EXEC sp_rename ${nstr(table)}, ${nstr(newName)}, 'OBJECT'`
    )
  }
  return out
}

/**
 * Joins statements into a runnable script. T-SQL runs each statement as its
 * own batch inside a transaction that XACT_ABORT rolls back on failure;
 * PostgreSQL runs a multi-statement script in one implicit transaction.
 */
export function ddlScript(dialect: Dialect, statements: string[]): string {
  if (!statements.length) return ''
  if (dialect === 'tsql') {
    return [
      'SET XACT_ABORT ON;\nBEGIN TRANSACTION;',
      ...statements.map((s) => `${s};`),
      'COMMIT TRANSACTION;'
    ].join('\nGO\n')
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
