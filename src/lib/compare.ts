import type { IndexInfo, ObjectKind, TableInfo, TriggerInfo } from './api'
import {
  columnChanged,
  ddlScript,
  draftFromTable,
  draftId,
  dropSchemaStatement,
  foreignKeyClause,
  newSchemaDraft,
  schemaStatements,
  tableStatements,
  type ColumnDraft,
  type ColumnState,
  type DdlOptions,
  type ForeignKeyAction,
  type ForeignKeyDraft,
  type IndexDraft,
  type TableDraft
} from './ddl'
import type { Dialect } from './engines'
import { qualified, quoteIdent, scriptCreateTable } from './sql'
import {
  extensionDiffers,
  pgConstraintIndexes,
  pgIndexSql,
  pgObjectSteps,
  pgTableSteps,
  pgTableText,
  withPartitionKey,
  type PgEnv,
  type PgOut,
  type PgPhase,
  type PgTableExtras,
  type PgTypeDetail
} from './compare-pg'
import { sequenceAlterStatements } from './mariadb-sequences'
import { dropTriggerStatement } from './triggers'

/* ---------- Snapshots ---------- */

/** How much of a database is compared. */
export type CompareScope = 'database' | 'schema' | 'table'

/** Kinds a comparison loads; triggers come with their tables. */
export const COMPARED_KINDS: ObjectKind[] = [
  'table',
  'view',
  'materialized_view',
  'function',
  'procedure',
  'sequence'
]

/** What a comparison covers: catalog objects, plus PostgreSQL types and extensions. */
export type CompareKind = ObjectKind | 'type' | 'extension'

export interface SnapshotObject {
  schema: string | null
  name: string
  kind: CompareKind
  /** PostgreSQL routine identity arguments */
  detail: string | null
  /** Tables only */
  table?: TableInfo
  /** Views, routines and sequences: the CREATE statement the server reports */
  definition?: string | null
  /** PostgreSQL tables: constraints and partitions `table` doesn't cover */
  pg?: PgTableExtras
  /** PostgreSQL types: labels, attributes or domain details */
  pgType?: PgTypeDetail
}

/** One side of a comparison as loaded from the server. */
export interface Snapshot {
  database: string
  /** Schema the comparison is limited to; null for a whole database (and always on MySQL) */
  schema: string | null
  /** Non-system schemas, loaded for whole-database comparisons on engines with schemas */
  schemas: string[]
  objects: SnapshotObject[]
}

/* ---------- Results ---------- */

/** What the script does to the target to make it match the source. */
export type DiffAction = 'create' | 'drop' | 'alter' | 'same'

export interface Change {
  action: 'add' | 'drop' | 'change'
  /** column, index, foreign key, primary key, trigger */
  what: string
  name: string
  /** The target's version */
  from?: string
  /** The source's version */
  to?: string
}

/** Script sections, run in this order whatever order the objects were compared in. */
const Phase = {
  Schemas: 0,
  Extensions: 1,
  Types: 2,
  DropForeignKeys: 3,
  DropDependents: 4,
  DropTables: 5,
  Sequences: 6,
  Tables: 7,
  ForeignKeys: 8,
  Routines: 9,
  Views: 10,
  Triggers: 11,
  DropSequences: 12,
  DropTypes: 13,
  DropExtensions: 14,
  DropSchemas: 15
} as const
type Phase = (typeof Phase)[keyof typeof Phase]

const PG_PHASES: Record<PgPhase, Phase> = {
  extensions: Phase.Extensions,
  types: Phase.Types,
  detach: Phase.DropDependents,
  dropConstraints: Phase.DropDependents,
  tables: Phase.Tables,
  dropTypes: Phase.DropTypes,
  dropExtensions: Phase.DropExtensions
}

interface Step {
  phase: Phase
  sql: string
}

export interface DiffItem {
  /** Stable across reloads, for selection */
  id: string
  kind: CompareKind | 'schema'
  schema: string | null
  name: string
  action: DiffAction
  changes: Change[]
  /** DDL of each side for a side-by-side view, with the source already renamed into the target */
  sourceText: string
  targetText: string
  warnings: string[]
  steps: Step[]
}

export interface CompareContext {
  dialect: Dialect
  scope: CompareScope
  source: Snapshot
  target: Snapshot
  options?: DdlOptions
}

/* ---------- Naming ---------- */

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Replaces `from.` qualifiers (bare or quoted) with `to.`, so definitions read
 * from one schema or MySQL database can be compared with and created in another.
 */
export function rewriteQualifier(dialect: Dialect, text: string, from: string, to: string): string {
  if (!from || from === to) return text
  const target = `${quoteIdent(dialect, to)}.`
  const quoted = new Set([
    `"${from.replace(/"/g, '""')}"`,
    `\`${from.replace(/`/g, '``')}\``,
    `[${from.replace(/]/g, ']]')}]`
  ])
  let out = text
  for (const form of quoted) out = out.split(`${form}.`).join(target)
  if (/^[A-Za-z_][\w$]*$/.test(from)) {
    const flags = dialect === 'postgres' ? 'g' : 'gi'
    out = out.replace(new RegExp(`(?<![\\w$."\`\\]])${escapeRegex(from)}\\.`, flags), target)
  }
  return out
}

/** The source → target schema (or MySQL database) rename the comparison implies, if any. */
function renameOf(ctx: CompareContext): [string, string] | null {
  if (ctx.dialect === 'mysql')
    return ctx.source.database !== ctx.target.database
      ? [ctx.source.database, ctx.target.database]
      : null
  const { schema: from } = ctx.source
  const { schema: to } = ctx.target
  return from && to && from !== to ? [from, to] : null
}

function renamer(ctx: CompareContext): {
  text: (s: string) => string
  schema: (s: string | null) => string | null
} {
  const rename = renameOf(ctx)
  if (!rename) return { text: (s) => s, schema: (s) => s }
  const [from, to] = rename
  const caseless = ctx.dialect !== 'postgres'
  return {
    text: (s) => rewriteQualifier(ctx.dialect, s, from, to),
    schema: (s) =>
      s !== null && (caseless ? s.toLowerCase() === from.toLowerCase() : s === from) ? to : s
  }
}

/** The qualifier an object's statements use in the target: its schema, or the database on MySQL. */
function qualifierIn(ctx: CompareContext, side: Snapshot, schema: string | null): string | null {
  if (ctx.dialect === 'mysql') return side.database
  return side.schema ?? schema
}

/** MySQL and SQL Server compare names without case by default; PostgreSQL doesn't. */
const sameName = (dialect: Dialect, a: string, b: string): boolean =>
  dialect === 'postgres' ? a === b : a.toLowerCase() === b.toLowerCase()

const keyName = (dialect: Dialect, s: string): string =>
  dialect === 'postgres' ? s : s.toLowerCase()

function objectKey(ctx: CompareContext, o: SnapshotObject, detail: string | null): string {
  const kind = o.kind === 'foreign_table' ? 'table' : o.kind
  // Whole databases match objects schema by schema; narrower scopes map one schema onto another
  // Extensions are database-wide, whatever schema they're installed in
  const schema =
    ctx.scope === 'database' && ctx.dialect !== 'mysql' && o.kind !== 'extension'
      ? (o.schema ?? '')
      : ''
  const isRoutine = o.kind === 'function' || o.kind === 'procedure'
  // Comparing two tables matches them whatever they're called
  const name = ctx.scope === 'table' ? '' : o.name
  return [
    kind,
    keyName(ctx.dialect, schema),
    keyName(ctx.dialect, name),
    ctx.dialect === 'postgres' && isRoutine ? (detail ?? '') : ''
  ].join('\u0000')
}

/* ---------- Definitions ---------- */

/** A definition as it will be run: CRLFs, MySQL DEFINER clauses and trailing semicolons removed. */
export function cleanDefinition(dialect: Dialect, text: string): string {
  let out = text.replace(/\r\n?/g, '\n')
  // The definer may not exist on the target; the creating user becomes the definer instead
  if (dialect === 'mysql')
    out = out.replace(/\s+DEFINER\s*=\s*(?:`[^`]*`|'[^']*'|[^\s@]+)@(?:`[^`]*`|'[^']*'|\S+)/i, '')
  return out.trim().replace(/[;\s]+$/, '')
}

/** Whitespace-insensitive form for telling whether two definitions differ. */
const comparable = (dialect: Dialect, text: string): string =>
  cleanDefinition(dialect, text).replace(/\s+/g, ' ')

const KIND_KEYWORD: Partial<Record<CompareKind, string>> = {
  table: 'TABLE',
  foreign_table: 'FOREIGN TABLE',
  view: 'VIEW',
  materialized_view: 'MATERIALIZED VIEW',
  function: 'FUNCTION',
  procedure: 'PROCEDURE',
  sequence: 'SEQUENCE'
}

function dropStatement(
  dialect: Dialect,
  qualifier: string | null,
  o: Pick<SnapshotObject, 'kind' | 'name' | 'detail'>
): string {
  const name = qualified(dialect, { schema: qualifier, name: o.name })
  const isRoutine = o.kind === 'function' || o.kind === 'procedure'
  const signature = dialect === 'postgres' && isRoutine ? `(${o.detail ?? ''})` : ''
  // A sequence owned by a dropped table goes with it
  const ifExists = o.kind === 'sequence' && dialect === 'postgres' ? 'IF EXISTS ' : ''
  return `DROP ${KIND_KEYWORD[o.kind] ?? o.kind.toUpperCase()} ${ifExists}${name}${signature}`
}

/* ---------- Tables ---------- */

function describeColumn(c: ColumnState): string {
  const parts = [c.dataType]
  if (c.identity) parts.push('IDENTITY')
  if (!c.nullable) parts.push('NOT NULL')
  if (c.default) parts.push(`DEFAULT ${c.default}`)
  if (c.comment) parts.push(`COMMENT '${c.comment}'`)
  return parts.join(' ')
}

const lowerList = (xs: string[]): string => xs.map((x) => x.toLowerCase()).join(', ')

function describeIndex(ix: IndexInfo): string {
  return `${ix.unique ? 'UNIQUE ' : ''}(${ix.columns.join(', ')})${ix.method ? ` ${ix.method}` : ''}`
}

/** What makes two indexes the same apart from their names. */
function indexSignature(dialect: Dialect, ix: IndexInfo): string {
  // PostgreSQL's definition also covers expressions, predicates and operator classes
  if (dialect === 'postgres' && ix.definition)
    return ix.definition.replace(
      /^(CREATE\s+(?:UNIQUE\s+)?INDEX\s+)(?:CONCURRENTLY\s+)?(?:"(?:[^"]|"")+"|\S+)\s+ON\s+(?:ONLY\s+)?/i,
      '$1ON '
    )
  return `${ix.unique ? 'unique ' : ''}(${lowerList(ix.columns)}) ${(ix.method ?? '').toLowerCase()}`
}

type ForeignKey = TableInfo['foreignKeys'][number]

function describeForeignKey(fk: ForeignKey): string {
  const target = fk.refSchema ? `${fk.refSchema}.${fk.refTable}` : fk.refTable
  let text = `(${fk.columns.join(', ')}) → ${target} (${fk.refColumns.join(', ')})`
  if (fk.onDelete && fk.onDelete !== 'NO ACTION') text += ` ON DELETE ${fk.onDelete}`
  if (fk.onUpdate && fk.onUpdate !== 'NO ACTION') text += ` ON UPDATE ${fk.onUpdate}`
  return text
}

const foreignKeySignature = (fk: ForeignKey): string =>
  [
    lowerList(fk.columns),
    (fk.refSchema ?? '').toLowerCase(),
    fk.refTable.toLowerCase(),
    lowerList(fk.refColumns),
    fk.onDelete ?? 'NO ACTION',
    fk.onUpdate ?? 'NO ACTION'
  ].join('|')

/** Pairs items by name, then unmatched ones by signature (so auto-generated names don't count). */
function pair<T extends { name: string }>(
  dialect: Dialect,
  source: T[],
  target: T[],
  signature: (x: T) => string
): { matched: [T, T][]; added: T[]; removed: T[] } {
  const matched: [T, T][] = []
  const freeSource = new Set(source)
  const removed: T[] = []
  const unnamed: T[] = []
  for (const t of target) {
    const s = source.find((x) => freeSource.has(x) && sameName(dialect, x.name, t.name))
    if (s) {
      freeSource.delete(s)
      matched.push([s, t])
    } else unnamed.push(t)
  }
  for (const t of unnamed) {
    const s = [...freeSource].find((x) => signature(x) === signature(t))
    if (s) {
      freeSource.delete(s)
      matched.push([s, t])
    } else removed.push(t)
  }
  return { matched, added: [...freeSource], removed }
}

/** The source table with its schema references renamed into the target. */
function renameTable(ctx: CompareContext, info: TableInfo): TableInfo {
  const rename = renamer(ctx)
  return {
    ...info,
    columns: info.columns.map((c) => ({
      ...c,
      default: c.default === null ? null : rename.text(c.default)
    })),
    indexes: info.indexes.map((ix) => ({
      ...ix,
      definition: ix.definition === null ? null : rename.text(ix.definition)
    })),
    foreignKeys: info.foreignKeys.map((fk) => ({ ...fk, refSchema: rename.schema(fk.refSchema) })),
    triggers: info.triggers.map((tr) => ({
      ...tr,
      definition: tr.definition === null ? null : rename.text(tr.definition)
    }))
  }
}

/** CREATE TABLE text plus trigger definitions, for the side-by-side view. */
function tableText(
  dialect: Dialect,
  qualifier: string | null,
  name: string,
  info: TableInfo,
  pg?: { env: PgEnv; extras: PgTableExtras | undefined }
): string {
  const parts = [scriptCreateTable(dialect, { schema: qualifier, name }, info)]
  if (pg?.extras) {
    const lines = pgTableText(pg.env, qualified(dialect, { schema: qualifier, name }), pg.extras)
    if (lines.length) parts.push(lines.join('\n'))
  }
  for (const tr of info.triggers)
    if (tr.definition) parts.push(`${cleanDefinition(dialect, tr.definition)};`)
  return parts.join('\n\n')
}

/** Renaming and qualifying for the PostgreSQL extras in compare-pg.ts. */
function pgEnv(ctx: CompareContext): PgEnv {
  const rename = renamer(ctx)
  return {
    text: rename.text,
    schema: rename.schema,
    qualifier: (schema) => qualifierIn(ctx, ctx.target, schema)
  }
}

function pgOut(item: DiffItem): PgOut {
  return {
    changes: item.changes,
    warnings: item.warnings,
    step: (phase, sql) => void item.steps.push({ phase: PG_PHASES[phase], sql })
  }
}

/** The source's constraint and partition text with its schema references renamed. */
const renamedExtras = (env: PgEnv, extras: PgTableExtras): PgTableExtras => ({
  partitionKey: extras.partitionKey && env.text(extras.partitionKey),
  constraints: extras.constraints.map((c) => ({ ...c, definition: env.text(c.definition) })),
  partitions: extras.partitions.map((p) => ({ ...p, bound: env.text(p.bound) }))
})

const pgDefinitionIndex = (dialect: Dialect, ix: IndexInfo): boolean =>
  dialect === 'postgres' && !!ix.definition && /^CREATE\b/i.test(ix.definition)

function triggerSteps(
  ctx: CompareContext,
  qualifier: string | null,
  table: string,
  source: TriggerInfo[],
  target: TriggerInfo[],
  changes: Change[],
  warnings: string[]
): Step[] {
  const { dialect } = ctx
  const steps: Step[] = []
  const on = { schema: qualifier, table, isView: false }
  const tableName = qualified(dialect, { schema: qualifier, name: table })
  const create = (tr: TriggerInfo): void => {
    if (!tr.definition) {
      warnings.push(`Trigger ${tr.name}'s definition couldn't be read; create it by hand`)
      return
    }
    steps.push({ phase: Phase.Triggers, sql: cleanDefinition(dialect, tr.definition) })
    if (!tr.enabled && dialect !== 'mysql')
      steps.push({ phase: Phase.Triggers, sql: toggleTrigger(dialect, tableName, tr.name, false) })
  }
  const drop = (tr: TriggerInfo): void =>
    void steps.push({
      phase: Phase.DropDependents,
      sql: dropTriggerStatement(dialect, tr.name, on)
    })
  const definitionOf = (tr: TriggerInfo): string => comparable(dialect, tr.definition ?? '')
  const { matched, added, removed } = pair(dialect, source, target, definitionOf)
  for (const tr of removed) {
    changes.push({ action: 'drop', what: 'trigger', name: tr.name, from: triggerSummary(tr) })
    drop(tr)
  }
  for (const [s, t] of matched) {
    if (definitionOf(s) !== definitionOf(t) || !sameName(dialect, s.name, t.name)) {
      changes.push({
        action: 'change',
        what: 'trigger',
        name: s.name,
        from: triggerSummary(t),
        to: triggerSummary(s)
      })
      drop(t)
      create(s)
    } else if (s.enabled !== t.enabled && dialect !== 'mysql') {
      changes.push({
        action: 'change',
        what: 'trigger',
        name: s.name,
        from: t.enabled ? 'enabled' : 'disabled',
        to: s.enabled ? 'enabled' : 'disabled'
      })
      steps.push({
        phase: Phase.Triggers,
        sql: toggleTrigger(dialect, tableName, t.name, s.enabled)
      })
    }
  }
  for (const tr of added) {
    changes.push({ action: 'add', what: 'trigger', name: tr.name, to: triggerSummary(tr) })
    create(tr)
  }
  return steps
}

const triggerSummary = (tr: TriggerInfo): string =>
  `${tr.timing} ${tr.events.join(' OR ')}${tr.rowLevel ? ' FOR EACH ROW' : ''}${tr.enabled ? '' : ' (disabled)'}`

function toggleTrigger(dialect: Dialect, table: string, name: string, enabled: boolean): string {
  const q = quoteIdent(dialect, name)
  return dialect === 'postgres'
    ? `ALTER TABLE ${table} ${enabled ? 'ENABLE' : 'DISABLE'} TRIGGER ${q}`
    : `${enabled ? 'ENABLE' : 'DISABLE'} TRIGGER ${q} ON ${table}`
}

/** Index and foreign key drafts are created by hand here, so ids resolve through the draft's columns. */
function columnIds(draft: TableDraft, names: string[]): string[] {
  const find = (n: string): ColumnDraft | undefined =>
    draft.columns.find((c) => !c.dropped && c.name === n) ??
    draft.columns.find((c) => !c.dropped && c.name.toLowerCase() === n.toLowerCase())
  return names.map((n) => find(n)?.id ?? `?${n}`)
}

function newForeignKey(draft: TableDraft, fk: ForeignKey): ForeignKeyDraft {
  return {
    id: draftId(),
    original: null,
    initial: null,
    name: fk.name,
    columns: columnIds(draft, fk.columns),
    refSchema: fk.refSchema,
    refTable: fk.refTable,
    refColumns: fk.refColumns,
    onDelete: (fk.onDelete ?? 'NO ACTION') as ForeignKeyAction,
    onUpdate: (fk.onUpdate ?? 'NO ACTION') as ForeignKeyAction,
    dropped: false
  }
}

function newIndex(draft: TableDraft, ix: IndexInfo): IndexDraft {
  return {
    id: draftId(),
    original: null,
    name: ix.name,
    columns: columnIds(draft, ix.columns),
    unique: ix.unique,
    include: [],
    where: '',
    method: '',
    initial: null,
    locked: null,
    dropped: false
  }
}

function addForeignKeySteps(
  dialect: Dialect,
  draft: TableDraft,
  table: string,
  fks: ForeignKey[]
): Step[] {
  return fks.map((fk) => ({
    phase: Phase.ForeignKeys,
    sql: `ALTER TABLE ${table} ADD ${foreignKeyClause(dialect, draft, newForeignKey(draft, fk))}`
  }))
}

function createTable(ctx: CompareContext, o: SnapshotObject, item: DiffItem): void {
  const { dialect } = ctx
  const info = renameTable(ctx, o.table!)
  const qualifier = qualifierIn(ctx, ctx.target, o.schema)
  const table = qualified(dialect, { schema: qualifier, name: o.name })
  const loaded = draftFromTable(dialect, qualifier, o.name, info)
  const computed = loaded.columns.filter((c) => c.computed)
  for (const c of computed)
    item.warnings.push(`Computed column ${c.name} isn't scripted; add it to the new table by hand`)
  const draft: TableDraft = {
    ...loaded,
    columns: loaded.columns.filter((c) => !c.computed).map((c) => ({ ...c, original: null })),
    indexes: info.indexes
      .filter((ix) => !ix.primary && !pgDefinitionIndex(dialect, ix))
      .map((ix) => newIndex(loaded, ix)),
    foreignKeys: [],
    original: null
  }
  // Indexes behind UNIQUE and EXCLUDE constraints are created by the constraints
  const constraintIndexes = pgConstraintIndexes(o.pg)
  for (const sql of tableStatements(dialect, draft, ctx.options))
    item.steps.push({ phase: Phase.Tables, sql: withPartitionKey(sql, o.pg?.partitionKey ?? null) })
  for (const ix of info.indexes)
    if (!ix.primary && pgDefinitionIndex(dialect, ix) && !constraintIndexes.has(ix.name))
      item.steps.push({ phase: Phase.Tables, sql: pgIndexSql(ix.definition!) })
  if (dialect === 'postgres' && o.pg) pgTableSteps(pgEnv(ctx), table, o.pg, undefined, pgOut(item))
  // Added after every table exists, so tables can reference each other in any order
  item.steps.push(...addForeignKeySteps(dialect, draft, table, info.foreignKeys))
  item.steps.push(...triggerSteps(ctx, qualifier, o.name, info.triggers, [], [], item.warnings))
}

function alterTable(
  ctx: CompareContext,
  source: SnapshotObject,
  target: SnapshotObject,
  item: DiffItem
): void {
  const { dialect } = ctx
  const s = renameTable(ctx, source.table!)
  const t = target.table!
  const qualifier = qualifierIn(ctx, ctx.target, target.schema)
  const table = qualified(dialect, { schema: qualifier, name: target.name })
  const loaded = draftFromTable(dialect, qualifier, target.name, t)
  const wanted = draftFromTable(dialect, qualifier, target.name, s)
  const changes = item.changes

  // Columns: the target's drafts edited to the source's definitions
  const columns: ColumnDraft[] = loaded.columns.map((c) => ({ ...c }))
  const idOf = new Map<string, string>()
  for (const c of columns) {
    const want = wanted.columns.find((w) => sameName(dialect, w.name, c.name))
    if (!want) {
      c.dropped = true
      item.warnings.push(
        `Drops column ${c.name} and its data; if it was renamed, rename it in the target first`
      )
      changes.push({ action: 'drop', what: 'column', name: c.name, from: describeColumn(c) })
      continue
    }
    idOf.set(want.id, c.id)
    if (want.computed || c.computed) {
      if (want.computed !== c.computed || describeColumn(want) !== describeColumn(c)) {
        changes.push({
          action: 'change',
          what: 'column',
          name: c.name,
          from: describeColumn(c),
          to: describeColumn(want)
        })
        item.warnings.push(`Computed column ${c.name} differs; it isn't scripted`)
      }
      continue
    }
    // SQL Server can't add or remove IDENTITY on an existing column
    const keepIdentity = dialect === 'tsql' && want.identity !== c.identity
    if (keepIdentity)
      item.warnings.push(
        `Column ${c.name}'s IDENTITY differs; SQL Server can't change it on an existing column, so it isn't scripted`
      )
    Object.assign(c, {
      dataType: want.dataType,
      nullable: want.nullable,
      default: want.default,
      identity: keepIdentity ? c.identity : want.identity,
      comment: want.comment,
      onUpdate: want.onUpdate
    })
  }
  for (const want of wanted.columns) {
    if (idOf.has(want.id)) continue
    if (want.computed) {
      changes.push({ action: 'add', what: 'column', name: want.name, to: describeColumn(want) })
      item.warnings.push(`Computed column ${want.name} isn't scripted; add it by hand`)
      continue
    }
    const added: ColumnDraft = { ...want, id: draftId(), original: null }
    columns.push(added)
    idOf.set(want.id, added.id)
    changes.push({ action: 'add', what: 'column', name: want.name, to: describeColumn(want) })
  }
  const primaryKey = wanted.primaryKey.map((id) => idOf.get(id) ?? id)

  // Indexes
  const indexes: IndexDraft[] = loaded.indexes.map((ix) => ({ ...ix }))
  const extraIndexSql: string[] = []
  // With PostgreSQL constraints loaded on both sides, their indexes are compared as constraints
  const pg = dialect === 'postgres' && source.pg && target.pg ? [source.pg, target.pg] : null
  const nonPrimary = (info: TableInfo, extras?: PgTableExtras): IndexInfo[] => {
    const skip = pgConstraintIndexes(extras)
    return info.indexes.filter((ix) => !ix.primary && !skip.has(ix.name))
  }
  const indexPairs = pair(dialect, nonPrimary(s, pg?.[0]), nonPrimary(t, pg?.[1]), (ix) =>
    indexSignature(dialect, ix)
  )
  const dropIndex = (ix: IndexInfo): void => {
    const draft = indexes.find((d) => d.original === ix)
    if (draft) draft.dropped = true
  }
  const addIndex = (ix: IndexInfo, draft: TableDraft): void => {
    if (pgDefinitionIndex(dialect, ix)) extraIndexSql.push(pgIndexSql(ix.definition!))
    else indexes.push(newIndex(draft, ix))
  }
  const desired: TableDraft = {
    ...loaded,
    columns,
    primaryKey,
    indexes,
    foreignKeys: loaded.foreignKeys
  }
  for (const ix of indexPairs.removed) {
    changes.push({ action: 'drop', what: 'index', name: ix.name, from: describeIndex(ix) })
    dropIndex(ix)
  }
  for (const [si, ti] of indexPairs.matched) {
    if (indexSignature(dialect, si) === indexSignature(dialect, ti)) continue
    changes.push({
      action: 'change',
      what: 'index',
      name: ti.name,
      from: describeIndex(ti),
      to: describeIndex(si)
    })
    dropIndex(ti)
    addIndex(si, desired)
  }
  for (const ix of indexPairs.added) {
    changes.push({ action: 'add', what: 'index', name: ix.name, to: describeIndex(ix) })
    addIndex(ix, desired)
  }

  // Foreign keys: dropped up front and added at the end, around every table's changes
  const fkPairs = pair(dialect, s.foreignKeys, t.foreignKeys, foreignKeySignature)
  const droppedFks = new Set<ForeignKey>(fkPairs.removed)
  const addedFks: ForeignKey[] = [...fkPairs.added]
  for (const fk of fkPairs.removed)
    changes.push({
      action: 'drop',
      what: 'foreign key',
      name: fk.name,
      from: describeForeignKey(fk)
    })
  for (const [sf, tf] of fkPairs.matched) {
    if (foreignKeySignature(sf) === foreignKeySignature(tf)) continue
    changes.push({
      action: 'change',
      what: 'foreign key',
      name: tf.name,
      from: describeForeignKey(tf),
      to: describeForeignKey(sf)
    })
    droppedFks.add(tf)
    addedFks.push(sf)
  }
  for (const fk of fkPairs.added)
    changes.push({ action: 'add', what: 'foreign key', name: fk.name, to: describeForeignKey(fk) })

  if (droppedFks.size) {
    const dropOnly: TableDraft = {
      ...loaded,
      foreignKeys: loaded.foreignKeys.map((fk) => ({
        ...fk,
        dropped: droppedFks.has(fk.original!)
      }))
    }
    for (const sql of tableStatements(dialect, dropOnly, ctx.options))
      item.steps.push({ phase: Phase.DropForeignKeys, sql })
  }
  desired.foreignKeys = loaded.foreignKeys.filter((fk) => !droppedFks.has(fk.original!))

  // Primary key and column changes, now that the draft is complete
  const pkNames = (draft: TableDraft, ids: string[]): string[] =>
    ids.map((id) => draft.columns.find((c) => c.id === id)?.name ?? id)
  const pkFrom = t.primaryKey
  const pkTo = pkNames(desired, primaryKey)
  if (lowerList(pkFrom) !== lowerList(pkTo))
    changes.push({
      action: pkFrom.length ? (pkTo.length ? 'change' : 'drop') : 'add',
      what: 'primary key',
      name: loaded.original?.primaryKeyName ?? 'primary key',
      from: pkFrom.length ? `(${pkFrom.join(', ')})` : undefined,
      to: pkTo.length ? `(${pkTo.join(', ')})` : undefined
    })
  for (const c of columns) {
    if (!c.original || c.dropped || !columnChanged(desired, c)) continue
    changes.push({
      action: 'change',
      what: 'column',
      name: c.name,
      from: describeColumn(c.original),
      to: describeColumn(c)
    })
  }

  for (const sql of tableStatements(dialect, desired, ctx.options))
    item.steps.push({ phase: Phase.Tables, sql })
  for (const sql of extraIndexSql) item.steps.push({ phase: Phase.Tables, sql })
  if (pg) pgTableSteps(pgEnv(ctx), table, pg[0], pg[1], pgOut(item))
  item.steps.push(...addForeignKeySteps(dialect, desired, table, addedFks))
  item.steps.push(
    ...triggerSteps(ctx, qualifier, target.name, s.triggers, t.triggers, changes, item.warnings)
  )
  const env = pgEnv(ctx)
  item.sourceText = tableText(dialect, qualifier, target.name, s, {
    env,
    extras: pg ? renamedExtras(env, pg[0]) : undefined
  })
  item.targetText = tableText(dialect, qualifier, target.name, t, { env, extras: pg?.[1] })
}

/* ---------- Views, routines, sequences ---------- */

function createPhase(kind: CompareKind): Phase {
  if (kind === 'sequence') return Phase.Sequences
  if (kind === 'view' || kind === 'materialized_view') return Phase.Views
  return Phase.Routines
}

function definitionSteps(
  ctx: CompareContext,
  source: SnapshotObject | undefined,
  target: SnapshotObject | undefined,
  item: DiffItem
): void {
  const { dialect } = ctx
  const o = (source ?? target)!
  const qualifier = qualifierIn(ctx, ctx.target, target?.schema ?? o.schema)
  const create = source?.definition ? cleanDefinition(dialect, source.definition) : null
  const drop = (): void => {
    const kind = o.kind === 'sequence' ? Phase.DropSequences : Phase.DropDependents
    item.steps.push({ phase: kind, sql: dropStatement(dialect, qualifier, target ?? o) })
  }
  if (item.action === 'drop') return drop()
  if (!create) {
    item.warnings.push(`The source's definition of ${o.name} couldn't be read; it isn't scripted`)
    return
  }
  if (item.action === 'alter') {
    if (o.kind === 'sequence' && dialect === 'postgres') {
      // Recreating a sequence would restart it; ALTER takes the same options
      let alter = create.replace(/^CREATE\s+SEQUENCE/i, 'ALTER SEQUENCE')
      if (!/\bCYCLE$/i.test(alter)) alter += ' NO CYCLE'
      item.steps.push({ phase: Phase.Sequences, sql: alter })
      return
    }
    if (o.kind === 'sequence' && dialect === 'mysql') {
      // MariaDB: the same, as long as both definitions can be read
      const name = qualified(dialect, { schema: qualifier, name: o.name })
      const alters = sequenceAlterStatements(name, create, target?.definition)
      if (alters) {
        for (const sql of alters) item.steps.push({ phase: Phase.Sequences, sql })
        return
      }
    }
    // PostgreSQL replaces functions in place; views are recreated in case their columns changed
    const replaces =
      dialect === 'postgres' && /^CREATE\s+OR\s+REPLACE\s+(FUNCTION|PROCEDURE)/i.test(create)
    if (!replaces) drop()
  }
  item.steps.push({ phase: createPhase(o.kind), sql: create })
}

/* ---------- Comparing ---------- */

const KIND_ORDER: (CompareKind | 'schema')[] = [
  'schema',
  'extension',
  'type',
  'table',
  'foreign_table',
  'view',
  'materialized_view',
  'function',
  'procedure',
  'sequence'
]

/** PostgreSQL identity columns own a sequence their table creates and drops itself. */
function withoutIdentitySequences(dialect: Dialect, objects: SnapshotObject[]): SnapshotObject[] {
  if (dialect !== 'postgres') return objects
  const owned = new Set<string>()
  for (const o of objects)
    for (const c of o.table?.columns ?? [])
      if (c.isIdentity) owned.add(`${o.schema ?? ''}.${o.name}_${c.name}_seq`)
  return objects.filter((o) => o.kind !== 'sequence' || !owned.has(`${o.schema ?? ''}.${o.name}`))
}

/** Compares two snapshots; each item carries the steps that make the target match the source. */
export function compareSnapshots(ctx: CompareContext): DiffItem[] {
  const { dialect } = ctx
  const sourceObjects = withoutIdentitySequences(dialect, ctx.source.objects)
  const targetObjects = withoutIdentitySequences(dialect, ctx.target.objects)
  const rename = renamer(ctx)
  const items: DiffItem[] = []

  if (ctx.scope === 'database' && dialect !== 'mysql') {
    const target = new Set(ctx.target.schemas.map((s) => keyName(dialect, s)))
    const source = new Set(ctx.source.schemas.map((s) => keyName(dialect, s)))
    for (const name of ctx.source.schemas) {
      if (target.has(keyName(dialect, name))) continue
      items.push({
        ...emptyItem(`schema\u0000${name}`, 'schema', null, name, 'create'),
        sourceText: `CREATE SCHEMA ${quoteIdent(dialect, name)}`,
        steps: schemaStatements(dialect, { ...newSchemaDraft(), name }, ctx.options).map((sql) => ({
          phase: Phase.Schemas,
          sql
        }))
      })
    }
    for (const name of ctx.target.schemas) {
      if (source.has(keyName(dialect, name))) continue
      items.push({
        ...emptyItem(`schema\u0000${name}`, 'schema', null, name, 'drop'),
        targetText: `CREATE SCHEMA ${quoteIdent(dialect, name)}`,
        warnings: ['Dropping a schema fails unless it is empty'],
        steps: [{ phase: Phase.DropSchemas, sql: dropSchemaStatement(dialect, name, false) }]
      })
    }
  }

  const targets = new Map<string, SnapshotObject>()
  for (const o of targetObjects) targets.set(objectKey(ctx, o, o.detail), o)
  const matched = new Set<SnapshotObject>()

  for (const raw of sourceObjects) {
    const o: SnapshotObject = {
      ...raw,
      detail: raw.detail === null ? null : rename.text(raw.detail),
      definition: raw.definition ? rename.text(raw.definition) : raw.definition
    }
    const key = objectKey(ctx, o, o.detail)
    const target = targets.get(key)
    if (target) matched.add(target)
    const schema = target?.schema ?? qualifierIn(ctx, ctx.target, o.schema)
    const isTable = o.kind === 'table' || o.kind === 'foreign_table'
    const item = emptyItem(key, o.kind, dialect === 'mysql' ? null : schema, o.name, 'create')
    if (isTable) {
      if (!o.table || (target && !target.table)) {
        item.action = 'same'
        item.warnings.push(`${o.name}'s structure couldn't be read`)
      } else if (target) {
        alterTable(ctx, o, target, item)
        item.action = item.steps.length || item.changes.length ? 'alter' : 'same'
        if (!sameName(dialect, o.name, target.name) && o.table.triggers.length)
          item.warnings.push(
            `Trigger definitions name ${o.name}; check they're created on ${target.name}`
          )
      } else {
        createTable(ctx, o, item)
        const env = pgEnv(ctx)
        item.sourceText = tableText(
          dialect,
          qualifierIn(ctx, ctx.target, o.schema),
          o.name,
          renameTable(ctx, o.table),
          { env, extras: o.pg && renamedExtras(env, o.pg) }
        )
      }
      if (o.kind === 'foreign_table' && item.action !== 'same') {
        item.warnings.push(
          'Foreign tables are compared as plain tables; check the server and options'
        )
      }
    } else {
      const sourceText = o.definition ? cleanDefinition(dialect, o.definition) : ''
      const targetText = target?.definition ? cleanDefinition(dialect, target.definition) : ''
      item.sourceText = sourceText
      item.targetText = targetText
      const isPg = o.kind === 'type' || o.kind === 'extension'
      if (target) {
        const differs =
          o.kind === 'extension'
            ? extensionDiffers(pgEnv(ctx), o, target)
            : !!sourceText &&
              !!targetText &&
              comparable(dialect, sourceText) !== comparable(dialect, targetText)
        item.action = differs ? 'alter' : 'same'
      }
      if (item.action !== 'same') {
        if (isPg) pgObjectSteps(pgEnv(ctx), o, target, pgOut(item))
        else definitionSteps(ctx, o, target, item)
      }
    }
    items.push(item)
  }

  for (const o of targetObjects) {
    if (matched.has(o)) continue
    const key = objectKey(ctx, o, o.detail)
    const qualifier = qualifierIn(ctx, ctx.target, o.schema)
    const item = emptyItem(key, o.kind, dialect === 'mysql' ? null : o.schema, o.name, 'drop')
    if (o.kind === 'table' || o.kind === 'foreign_table') {
      item.targetText = o.table
        ? tableText(dialect, qualifier, o.name, o.table, { env: pgEnv(ctx), extras: o.pg })
        : ''
      item.warnings.push(`Drops ${o.name} and all of its data`)
      item.steps.push({ phase: Phase.DropTables, sql: dropStatement(dialect, qualifier, o) })
    } else if (o.kind === 'type' || o.kind === 'extension') {
      item.targetText = o.definition ? cleanDefinition(dialect, o.definition) : ''
      pgObjectSteps(pgEnv(ctx), undefined, o, pgOut(item))
    } else {
      item.targetText = o.definition ? cleanDefinition(dialect, o.definition) : ''
      definitionSteps(ctx, undefined, o, item)
    }
    items.push(item)
  }

  return items.sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
      (a.schema ?? '').localeCompare(b.schema ?? '') ||
      a.name.localeCompare(b.name)
  )
}

function emptyItem(
  id: string,
  kind: DiffItem['kind'],
  schema: string | null,
  name: string,
  action: DiffAction
): DiffItem {
  return {
    id,
    kind,
    schema,
    name,
    action,
    changes: [],
    sourceText: '',
    targetText: '',
    warnings: [],
    steps: []
  }
}

/** How many objects or columns, with their data, the item drops. */
export function dropCount(item: DiffItem): number {
  if (item.action === 'drop') return 1
  if (item.action !== 'alter') return 0
  return item.changes.filter((c) => c.action === 'drop' && c.what === 'column').length
}

/**
 * Items selected by default: everything that differs except drops, which are opt-in,
 * as are alters that drop columns (a renamed column looks like a drop and an add).
 */
export function defaultSelection(items: DiffItem[]): Set<string> {
  return new Set(
    items
      .filter((i) => (i.action === 'create' || i.action === 'alter') && !dropCount(i))
      .map((i) => i.id)
  )
}

/** The selected items' steps as one script, ordered so dependencies exist before they're used. */
export function migrationStatements(items: DiffItem[], selected: Set<string>): string[] {
  return items
    .filter((i) => selected.has(i.id))
    .flatMap((i) => i.steps)
    .map((step, order) => ({ ...step, order }))
    .sort((a, b) => a.phase - b.phase || a.order - b.order)
    .map((s) => s.sql)
}

export function migrationScript(
  dialect: Dialect,
  items: DiffItem[],
  selected: Set<string>
): string {
  return ddlScript(dialect, migrationStatements(items, selected))
}

/* ---------- Line diff ---------- */

export interface DiffLine {
  /** 1-based line numbers; null where the other side has a line this one doesn't */
  left: { line: number; text: string } | null
  right: { line: number; text: string } | null
  kind: 'same' | 'removed' | 'added' | 'changed'
}

/**
 * Side-by-side line diff (longest common subsequence), with runs of removed and
 * added lines paired up as changed lines.
 */
export function diffLines(left: string, right: string): DiffLine[] {
  const a = left ? left.replace(/\r\n?/g, '\n').split('\n') : []
  const b = right ? right.replace(/\r\n?/g, '\n').split('\n') : []
  const n = a.length
  const m = b.length
  const ops: ('=' | '-' | '+')[] = []
  if (n * m > 4_000_000) {
    // Too big for the table; show everything as replaced
    ops.push(...a.map(() => '-' as const), ...b.map(() => '+' as const))
  } else {
    const width = m + 1
    const lcs = new Uint32Array((n + 1) * width)
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        lcs[i * width + j] =
          a[i] === b[j]
            ? lcs[(i + 1) * width + j + 1] + 1
            : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1])
    let i = 0
    let j = 0
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) {
        ops.push('=')
        i++
        j++
      } else if (j < m && (i === n || lcs[i * width + j + 1] >= lcs[(i + 1) * width + j])) {
        ops.push('+')
        j++
      } else {
        ops.push('-')
        i++
      }
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  let k = 0
  while (k < ops.length) {
    if (ops[k] === '=') {
      out.push({
        left: { line: i + 1, text: a[i] },
        right: { line: j + 1, text: b[j] },
        kind: 'same'
      })
      i++
      j++
      k++
      continue
    }
    const removed: number[] = []
    const added: number[] = []
    while (k < ops.length && ops[k] !== '=') {
      if (ops[k] === '-') removed.push(i++)
      else added.push(j++)
      k++
    }
    for (let x = 0; x < Math.max(removed.length, added.length); x++) {
      const l = removed[x]
      const r = added[x]
      out.push({
        left: l === undefined ? null : { line: l + 1, text: a[l] },
        right: r === undefined ? null : { line: r + 1, text: b[r] },
        kind: l === undefined ? 'added' : r === undefined ? 'removed' : 'changed'
      })
    }
  }
  return out
}
