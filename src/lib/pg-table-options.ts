/**
 * PostgreSQL table options for the table designer: partitioning, exclusion
 * constraints, persistence (UNLOGGED), storage parameters, tablespace and the
 * table comment. Kept beside the draft in ddl.ts: the designer builds its
 * statements with tableStatements() and then withPgTableOptions().
 */
import { type Cell } from './api'
import { catalogRows, parsePartitions, partitionsSql } from './catalog'
import { draftId, indexName, primaryKeyOf, uniqueName, type TableDraft } from './ddl'
import { literal, qualified, quoteIdent } from './sql'
import type { ExclusionInfo } from './table-extras'

export type PartitionStrategy = 'RANGE' | 'LIST' | 'HASH'

export interface PartitionKey {
  /** '' for a plain (unpartitioned) table */
  strategy: PartitionStrategy | ''
  /** Column draft ids, in key order */
  columns: string[]
  /** Key expression after the columns, '' for none */
  expression: string
}

export interface PartitionBound {
  isDefault: boolean
  /** RANGE bounds: SQL literals, comma-separated for multi-column keys, or MINVALUE / MAXVALUE */
  from: string
  to: string
  /** LIST values: comma-separated SQL literals */
  values: string
  /** HASH modulus and remainder */
  modulus: string
  remainder: string
}

/** A partition to create, or an existing table to attach as one. */
export interface PartitionDraft extends PartitionBound {
  id: string
  mode: 'create' | 'attach'
  /** The new partition (in the parent's schema), or the table to attach */
  schema: string | null
  name: string
}

/** A partition the table already has. */
export interface ExistingPartition {
  schema: string | null
  name: string
  /** `FOR VALUES FROM ('2024-01-01') TO ('2025-01-01')` or `DEFAULT` */
  bound: string
  /** Itself partitioned (a sub-partitioned partition) */
  partitioned: boolean
  rows: number | null
  detach: boolean
  concurrently: boolean
}

export interface ExclusionElement {
  /** Column name or expression */
  expression: string
  operator: string
}

export type Deferrable = '' | 'DEFERRABLE' | 'DEFERRABLE INITIALLY DEFERRED'

export interface ExclusionDraft {
  id: string
  name: string
  /** Index access method, '' for gist */
  method: string
  elements: ExclusionElement[]
  /** Covering (INCLUDE) column draft ids */
  include: string[]
  where: string
  deferrable: Deferrable
  /** An existing constraint as loaded (drop-only); null for a new one */
  existing: ExclusionInfo | null
  dropped: boolean
}

export interface StorageParameter {
  id: string
  /** `fillfactor`, `autovacuum_enabled`, `toast.autovacuum_enabled` … */
  name: string
  value: string
}

export interface PgTableOptions {
  partitionKey: PartitionKey
  partitions: PartitionDraft[]
  existingPartitions: ExistingPartition[]
  exclusions: ExclusionDraft[]
  unlogged: boolean
  parameters: StorageParameter[]
  /** '' for the database default */
  tablespace: string
  comment: string
  /** Adds CREATE EXTENSION btree_gist when an exclusion constraint needs it */
  installBtreeGist: boolean
}

export interface PgTableContext {
  /** server_version_num, e.g. 170002 */
  version: number
  tablespaces: string[]
  /** The database's default tablespace */
  defaultTablespace: string
  btreeGist: { installed: boolean; available: boolean }
  /** The table's options as loaded; null when creating one */
  original: PgTableOptions | null
  /** An existing partitioned table's key, `RANGE (created_at)`; null otherwise */
  partitionedBy: string | null
  /** Its key column names (expressions left out) */
  partitionColumns: string[]
  /** The parent, when the table is itself a partition */
  partitionOf: string | null
}

export const newPgTableOptions = (): PgTableOptions => ({
  partitionKey: { strategy: '', columns: [], expression: '' },
  partitions: [],
  existingPartitions: [],
  exclusions: [],
  unlogged: false,
  parameters: [],
  tablespace: '',
  comment: '',
  installBtreeGist: true
})

export function newPartition(patch: Partial<PartitionDraft> = {}): PartitionDraft {
  return {
    id: draftId(),
    mode: 'create',
    schema: null,
    name: '',
    isDefault: false,
    from: '',
    to: '',
    values: '',
    modulus: '',
    remainder: '',
    ...patch
  }
}

export function newExclusion(patch: Partial<ExclusionDraft> = {}): ExclusionDraft {
  return {
    id: draftId(),
    name: '',
    method: '',
    elements: [{ expression: '', operator: '=' }],
    include: [],
    where: '',
    deferrable: '',
    existing: null,
    dropped: false,
    ...patch
  }
}

export const newParameter = (name = '', value = ''): StorageParameter => ({
  id: draftId(),
  name,
  value
})

/** Index methods an exclusion constraint can use; the first is the default. */
export const EXCLUSION_METHODS = ['gist', 'spgist', 'btree', 'hash']

/** Storage parameters offered in the designer (`toast.` ones apply to the TOAST table). */
export const STORAGE_PARAMETERS: { name: string; hint: string; since?: number }[] = [
  { name: 'fillfactor', hint: '10–100; space left free on each page for updates' },
  { name: 'autovacuum_enabled', hint: 'true / false' },
  { name: 'autovacuum_vacuum_threshold', hint: 'rows' },
  { name: 'autovacuum_vacuum_scale_factor', hint: 'fraction of the table, e.g. 0.05' },
  { name: 'autovacuum_vacuum_insert_threshold', hint: 'rows', since: 130000 },
  { name: 'autovacuum_vacuum_insert_scale_factor', hint: 'fraction', since: 130000 },
  { name: 'autovacuum_analyze_threshold', hint: 'rows' },
  { name: 'autovacuum_analyze_scale_factor', hint: 'fraction' },
  { name: 'autovacuum_vacuum_cost_delay', hint: 'milliseconds' },
  { name: 'autovacuum_vacuum_cost_limit', hint: '1–10000' },
  { name: 'autovacuum_freeze_min_age', hint: 'transactions' },
  { name: 'autovacuum_freeze_max_age', hint: 'transactions' },
  { name: 'autovacuum_freeze_table_age', hint: 'transactions' },
  { name: 'log_autovacuum_min_duration', hint: 'milliseconds, -1 to disable' },
  { name: 'parallel_workers', hint: 'workers for parallel scans' },
  { name: 'toast_tuple_target', hint: 'bytes, 128–8160' },
  { name: 'vacuum_index_cleanup', hint: 'on / off, or auto on 14+' },
  { name: 'vacuum_truncate', hint: 'true / false' },
  { name: 'toast.autovacuum_enabled', hint: 'true / false' },
  { name: 'toast.autovacuum_vacuum_threshold', hint: 'rows' },
  { name: 'toast.autovacuum_vacuum_scale_factor', hint: 'fraction' },
  { name: 'toast.autovacuum_vacuum_cost_delay', hint: 'milliseconds' },
  { name: 'toast.autovacuum_freeze_max_age', hint: 'transactions' },
  { name: 'toast.vacuum_index_cleanup', hint: 'on / off, or auto on 14+' },
  { name: 'toast.vacuum_truncate', hint: 'true / false' }
]

/* ---------- Loading ---------- */

const str = (cell: Cell | undefined): string | null =>
  cell === null || cell === undefined ? null : String(cell)
const bool = (cell: Cell | undefined): boolean =>
  cell === true || str(cell) === 't' || str(cell) === 'true'
const jsonList = (cell: Cell | undefined): string[] => {
  try {
    const value: unknown = JSON.parse(str(cell) ?? '[]')
    return Array.isArray(value) ? value.map(String) : []
  } catch {
    return []
  }
}

/** Version, tablespaces and btree_gist: what even a new table's options need. */
export const pgServerSql = `SELECT current_setting('server_version_num')::int,
  array_to_json(ARRAY(SELECT spcname::text FROM pg_tablespace WHERE spcname <> 'pg_global' ORDER BY 1))::text,
  (SELECT t.spcname::text FROM pg_database d JOIN pg_tablespace t ON t.oid = d.dattablespace
    WHERE d.datname = current_database()),
  EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist'),
  EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'btree_gist')`

/** An existing table's persistence, storage parameters, tablespace, comment and partitioning. */
export function pgTableSql(schema: string | null, table: string): string {
  const rel = `format('%I.%I', ${literal('postgres', schema ?? 'public')}, ${literal('postgres', table)})::regclass`
  return `SELECT c.relkind::text, c.relpersistence::text,
  array_to_json(coalesce(c.reloptions, '{}'))::text,
  array_to_json(coalesce(t.reloptions, '{}'))::text,
  ts.spcname::text, obj_description(c.oid, 'pg_class'),
  CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END,
  array_to_json(ARRAY(SELECT a.attname::text
    FROM pg_partitioned_table pt
    JOIN LATERAL unnest(pt.partattrs::int2[]) WITH ORDINALITY k(n, o) ON true
    JOIN pg_attribute a ON a.attrelid = pt.partrelid AND a.attnum = k.n
    WHERE pt.partrelid = c.oid ORDER BY k.o))::text,
  (SELECT format('%I.%I', pn.nspname, pc.relname) FROM pg_inherits i
    JOIN pg_class pc ON pc.oid = i.inhparent JOIN pg_namespace pn ON pn.oid = pc.relnamespace
    WHERE i.inhrelid = c.oid AND c.relispartition)
FROM pg_class c
LEFT JOIN pg_class t ON t.oid = c.reltoastrelid
LEFT JOIN pg_tablespace ts ON ts.oid = c.reltablespace
WHERE c.oid = ${rel}`
}

/** Splits `name=value` reloptions; TOAST ones get the `toast.` prefix back. */
function parseReloptions(main: string[], toast: string[]): StorageParameter[] {
  const split = (o: string, prefix: string): StorageParameter => {
    const at = o.indexOf('=')
    return newParameter(prefix + (at < 0 ? o : o.slice(0, at)), at < 0 ? '' : o.slice(at + 1))
  }
  return [...main.map((o) => split(o, '')), ...toast.map((o) => split(o, 'toast.'))]
}

export interface PgTableRows {
  server: Cell[][]
  /** Missing when creating a table */
  table?: Cell[][]
  partitions?: Cell[][]
}

/** Builds the context from query rows; exclusions come from the table extras. */
export function parsePgTableContext(
  rows: PgTableRows,
  exclusions: ExclusionInfo[] = []
): PgTableContext {
  const s = rows.server[0] ?? []
  const context: PgTableContext = {
    version: Number(str(s[0]) ?? 0) || 0,
    tablespaces: jsonList(s[1]),
    defaultTablespace: str(s[2]) ?? 'pg_default',
    btreeGist: { installed: bool(s[3]), available: bool(s[4]) },
    original: null,
    partitionedBy: null,
    partitionColumns: [],
    partitionOf: null
  }
  const t = rows.table?.[0]
  if (!rows.table) return context
  if (!t) throw new Error('Table not found')
  context.partitionedBy = str(t[6])
  context.partitionColumns = jsonList(t[7])
  context.partitionOf = str(t[8])
  const tablespace = str(t[4]) ?? ''
  context.original = {
    ...newPgTableOptions(),
    unlogged: str(t[1]) === 'u',
    parameters: parseReloptions(jsonList(t[2]), jsonList(t[3])),
    // An explicit tablespace that is the database default reads the same as none
    tablespace: tablespace === context.defaultTablespace ? '' : tablespace,
    comment: str(t[5]) ?? '',
    existingPartitions: parsePartitions('postgres', rows.partitions ?? []).map((p) => ({
      schema: p.schema,
      name: p.name,
      bound: p.detail ?? '',
      partitioned: p.kind === 'partitioned',
      rows: p.rowEstimate,
      detach: false,
      concurrently: false
    })),
    exclusions: exclusions.map((x) => newExclusion({ name: x.name, existing: x }))
  }
  return context
}

export async function loadPgTableContext(
  connectionId: string,
  database: string,
  schema: string | null,
  table: string | null,
  exclusions: ExclusionInfo[] = []
): Promise<PgTableContext> {
  const rows: PgTableRows = { server: await catalogRows(connectionId, database, [pgServerSql]) }
  if (table !== null) {
    rows.table = await catalogRows(connectionId, database, [pgTableSql(schema, table)])
    rows.partitions = await catalogRows(connectionId, database, [
      partitionsSql('postgres', schema, table)!
    ])
  }
  return parsePgTableContext(rows, exclusions)
}

/* ---------- Helpers ---------- */

const majorOf = (version: number): number => Math.floor(version / 10000)

/** DETACH PARTITION … CONCURRENTLY arrived in PostgreSQL 14. */
export const canDetachConcurrently = (context: PgTableContext): boolean => context.version >= 140000

/** Exclusion constraints on partitioned tables arrived in PostgreSQL 17. */
export const canExcludeOnPartitioned = (context: PgTableContext): boolean =>
  context.version >= 170000

/** The strategy the table is (or will be) partitioned by, or ''. */
export function partitionStrategy(
  options: PgTableOptions,
  context: PgTableContext | null,
  creating: boolean
): PartitionStrategy | '' {
  if (creating) return options.partitionKey.strategy
  const m = /^(RANGE|LIST|HASH)\b/i.exec(context?.partitionedBy ?? '')
  return m ? (m[1].toUpperCase() as PartitionStrategy) : ''
}

const liveColumnIds = (draft: TableDraft): Set<string> =>
  new Set(draft.columns.filter((c) => !c.dropped).map((c) => c.id))

const columnNameOf = (draft: TableDraft, id: string): string =>
  draft.columns.find((c) => c.id === id)?.name.trim() ?? id.replace(/^\?/, '')

/** Key column ids of a new table that are still in the draft. */
function keyColumns(draft: TableDraft, key: PartitionKey): string[] {
  const live = liveColumnIds(draft)
  return key.columns.filter((id) => live.has(id))
}

/** Key column names of the table, new or existing. */
function partitionColumnNames(
  draft: TableDraft,
  options: PgTableOptions,
  context: PgTableContext | null
): string[] {
  if (!draft.original)
    return keyColumns(draft, options.partitionKey).map((id) => columnNameOf(draft, id))
  return context?.partitionColumns ?? []
}

/** `PARTITION BY RANGE (created_at, (lower(region)))` */
export function partitionByClause(draft: TableDraft, key: PartitionKey): string | null {
  if (!key.strategy) return null
  const elements = [
    ...keyColumns(draft, key).map((id) => quoteIdent('postgres', columnNameOf(draft, id))),
    ...(key.expression.trim() ? [`(${key.expression.trim()})`] : [])
  ]
  return `PARTITION BY ${key.strategy} (${elements.join(', ')})`
}

/** `FOR VALUES FROM (…) TO (…)`, `FOR VALUES IN (…)`, `FOR VALUES WITH (…)` or `DEFAULT`. */
export function boundClause(strategy: PartitionStrategy | '', b: PartitionBound): string {
  if (b.isDefault && strategy !== 'HASH') return 'DEFAULT'
  switch (strategy) {
    case 'RANGE':
      return `FOR VALUES FROM (${b.from.trim()}) TO (${b.to.trim()})`
    case 'LIST':
      return `FOR VALUES IN (${b.values.trim()})`
    case 'HASH':
      return `FOR VALUES WITH (MODULUS ${b.modulus.trim()}, REMAINDER ${b.remainder.trim()})`
    default:
      return ''
  }
}

export function exclusionName(draft: TableDraft, x: ExclusionDraft): string {
  if (x.name.trim()) return x.name.trim()
  // Named after its plain-column elements, like PostgreSQL's own table_room_during_excl
  const columns = x.elements
    .map((e) => e.expression.trim())
    .filter((e) => /^[\w$]+$/.test(e))
    .join('_')
  return `ex_${draft.name.trim()}${columns ? `_${columns}` : ''}`
}

const newExclusions = (xs: ExclusionDraft[]): ExclusionDraft[] =>
  xs.filter((x) => !x.existing && !x.dropped)

/** An element written as the index takes it: a column as is, an expression in parentheses. */
function exclusionElement(draft: TableDraft, e: ExclusionElement): string {
  const expr = e.expression.trim()
  const column = draft.columns.find((c) => !c.dropped && c.name.trim() === expr)
  const key = column
    ? quoteIdent('postgres', expr)
    : /^[a-z_][a-z0-9_$]*$/.test(expr)
      ? expr
      : `(${expr})`
  return `${key} WITH ${e.operator.trim()}`
}

export function exclusionClause(draft: TableDraft, x: ExclusionDraft): string {
  const method = x.method.trim() || EXCLUSION_METHODS[0]
  const include = x.include.filter((id) => liveColumnIds(draft).has(id))
  return [
    `CONSTRAINT ${quoteIdent('postgres', exclusionName(draft, x))} EXCLUDE USING ${method} (${x.elements
      .map((e) => exclusionElement(draft, e))
      .join(', ')})`,
    include.length
      ? `INCLUDE (${include.map((id) => quoteIdent('postgres', columnNameOf(draft, id))).join(', ')})`
      : '',
    x.where.trim() ? `WHERE (${x.where.trim()})` : '',
    x.deferrable
  ]
    .filter(Boolean)
    .join(' ')
}

/** Range, multirange and geometric types have GiST equality without btree_gist. */
const GIST_NATIVE =
  /(range|multirange|box|point|polygon|circle|tsvector|tsquery|geometry|geography|ltree|cube)\b|\[\]$/i

/** New exclusion constraints that compare scalar values with = or <> under GiST. */
export function needsBtreeGist(draft: TableDraft, options: PgTableOptions): ExclusionDraft[] {
  return newExclusions(options.exclusions).filter(
    (x) =>
      (x.method.trim() || 'gist').toLowerCase() === 'gist' &&
      x.elements.some((e) => {
        if (!/^(=|<>)$/.test(e.operator.trim())) return false
        const column = draft.columns.find((c) => c.name.trim() === e.expression.trim())
        return !column || !GIST_NATIVE.test(column.dataType.trim())
      })
  )
}

const btreeGistStatement = 'CREATE EXTENSION IF NOT EXISTS btree_gist'

function wantsBtreeGist(
  draft: TableDraft,
  options: PgTableOptions,
  context: PgTableContext
): boolean {
  return (
    options.installBtreeGist &&
    !context.btreeGist.installed &&
    needsBtreeGist(draft, options).length > 0
  )
}

/** Parameters as a name → value map; the last of duplicate names wins. */
const parameterMap = (parameters: StorageParameter[]): Map<string, string> =>
  new Map(
    parameters
      .filter((p) => p.name.trim())
      .map((p) => [p.name.trim().toLowerCase(), p.value.trim()] as const)
  )

function parameterChanges(
  options: PgTableOptions,
  original: PgTableOptions | null
): { set: [string, string][]; reset: string[] } {
  const now = parameterMap(options.parameters)
  const was = parameterMap(original?.parameters ?? [])
  return {
    set: [...now].filter(([name, value]) => was.get(name) !== value),
    reset: [...was.keys()].filter((name) => !now.has(name))
  }
}

const isPartitioned = (
  draft: TableDraft,
  options: PgTableOptions,
  context: PgTableContext | null
): boolean => (draft.original ? !!context?.partitionedBy : !!options.partitionKey.strategy)

const newPartitions = (options: PgTableOptions): PartitionDraft[] => options.partitions

const detached = (options: PgTableOptions): ExistingPartition[] =>
  options.existingPartitions.filter((p) => p.detach)

/* ---------- Statements ---------- */

/**
 * Adds the PostgreSQL options to the designer's statements. A new table gets
 * UNLOGGED, PARTITION BY, WITH (…) and TABLESPACE on its CREATE TABLE; an
 * existing one ALTER TABLEs, after the base statements (and so under its new
 * name). Exclusion constraints are dropped and partitions detached first, before
 * the columns they use can go.
 */
export function withPgTableOptions(
  statements: string[],
  draft: TableDraft,
  options: PgTableOptions,
  context: PgTableContext
): string[] {
  const creating = !draft.original
  const original = creating ? null : context.original
  if (!creating && !original) return statements
  const name = draft.name.trim()
  const table = qualified('postgres', { schema: draft.schema, name })
  const before: string[] = []
  const after: string[] = []
  if (wantsBtreeGist(draft, options, context)) before.push(btreeGistStatement)
  let base = statements
  const strategy = partitionStrategy(options, context, creating)

  if (creating) {
    const clauses = [
      partitionByClause(draft, options.partitionKey),
      ...(() => {
        const set = parameterChanges(options, null).set
        return set.length ? [`WITH (${set.map(([k, v]) => `${k} = ${v}`).join(', ')})`] : []
      })(),
      options.tablespace ? `TABLESPACE ${quoteIdent('postgres', options.tablespace)}` : null
    ].filter((c): c is string => !!c)
    base = statements.map((s) => {
      if (!/^CREATE TABLE\b/.test(s)) return s
      const head = options.unlogged ? s.replace(/^CREATE TABLE\b/, 'CREATE UNLOGGED TABLE') : s
      return clauses.length ? `${head} ${clauses.join(' ')}` : head
    })
    if (options.comment.trim())
      after.push(`COMMENT ON TABLE ${table} IS ${literal('postgres', options.comment.trim())}`)
  } else {
    const was = original!
    const oldTable = qualified('postgres', { schema: draft.schema, name: draft.original!.name })
    for (const x of options.exclusions)
      if (x.existing && x.dropped)
        before.push(`ALTER TABLE ${oldTable} DROP CONSTRAINT ${quoteIdent('postgres', x.name)}`)
    for (const p of detached(options))
      before.push(
        `ALTER TABLE ${oldTable} DETACH PARTITION ${qualified('postgres', p)}${p.concurrently ? ' CONCURRENTLY' : ''}`
      )
    if (options.unlogged !== was.unlogged)
      after.push(`ALTER TABLE ${table} SET ${options.unlogged ? 'UNLOGGED' : 'LOGGED'}`)
    const { set, reset } = parameterChanges(options, was)
    if (set.length)
      after.push(`ALTER TABLE ${table} SET (${set.map(([k, v]) => `${k} = ${v}`).join(', ')})`)
    if (reset.length) after.push(`ALTER TABLE ${table} RESET (${reset.join(', ')})`)
    if (options.tablespace !== was.tablespace)
      after.push(
        `ALTER TABLE ${table} SET TABLESPACE ${quoteIdent('postgres', options.tablespace || context.defaultTablespace)}`
      )
    if (options.comment.trim() !== was.comment.trim())
      after.push(
        `COMMENT ON TABLE ${table} IS ${options.comment.trim() ? literal('postgres', options.comment.trim()) : 'NULL'}`
      )
  }

  for (const x of newExclusions(options.exclusions))
    after.push(`ALTER TABLE ${table} ADD ${exclusionClause(draft, x)}`)
  for (const p of newPartitions(options)) {
    const target = qualified('postgres', {
      schema: p.mode === 'create' ? draft.schema : p.schema,
      name: p.name.trim()
    })
    after.push(
      p.mode === 'create'
        ? `CREATE TABLE ${target} PARTITION OF ${table} ${boundClause(strategy, p)}`
        : `ALTER TABLE ${table} ATTACH PARTITION ${target} ${boundClause(strategy, p)}`
    )
  }
  return [...before, ...base, ...after]
}

/** Number of separate option changes, for the dialog footer. */
export function countPgOptionChanges(
  draft: TableDraft,
  options: PgTableOptions,
  original: PgTableOptions | null
): number {
  if (!draft.original || !original) return 0
  const { set, reset } = parameterChanges(options, original)
  return (
    (options.unlogged !== original.unlogged ? 1 : 0) +
    set.length +
    reset.length +
    (options.tablespace !== original.tablespace ? 1 : 0) +
    (options.comment.trim() !== original.comment.trim() ? 1 : 0) +
    options.exclusions.filter((x) => (x.existing ? x.dropped : !x.dropped)).length +
    options.partitions.length +
    detached(options).length
  )
}

/* ---------- Validation ---------- */

const OPERATOR = /^[+\-*/<>=~!@#%^&|`?]+$/
const PARAMETER_NAME = /^(toast\.)?[a-z_][a-z0-9_]*$/
const PARAMETER_VALUE = /^[\w.+-]+$/
const INTEGER = /^\d+$/

/** The first problem that would make the script fail, or null. */
export function pgTableOptionProblem(
  draft: TableDraft,
  options: PgTableOptions,
  context: PgTableContext,
  statements: string[]
): string | null {
  const creating = !draft.original
  const partitioned = isPartitioned(draft, options, context)
  const strategy = partitionStrategy(options, context, creating)
  const keyNames = partitionColumnNames(draft, options, context)

  if (creating && options.partitionKey.strategy) {
    const key = options.partitionKey
    const columns = keyColumns(draft, key)
    const expression = key.expression.trim()
    if (!columns.length && !expression)
      return 'Pick the partition key columns or enter an expression'
    if (key.strategy === 'LIST' && columns.length + (expression ? 1 : 0) > 1)
      return 'List partitioning takes a single key column or expression'
    const keyed = [
      ...(primaryKeyOf(draft).length
        ? [{ label: 'The primary key', ids: primaryKeyOf(draft) }]
        : []),
      ...draft.uniques
        .filter((uq) => !uq.dropped)
        .map((uq) => ({ label: `Unique constraint ${uniqueName(draft, uq)}`, ids: uq.columns })),
      ...draft.indexes
        .filter((ix) => !ix.dropped && ix.unique)
        .map((ix) => ({ label: `Unique index ${indexName(draft, ix)}`, ids: ix.columns }))
    ]
    if (expression && keyed.length)
      return `${keyed[0].label} can't exist on a table partitioned by an expression; partition by columns or drop it`
    for (const k of keyed) {
      const missing = columns.filter((id) => !k.ids.includes(id))
      if (missing.length)
        return `${k.label} must include the partition key (${missing.map((id) => columnNameOf(draft, id)).join(', ')})`
    }
  }

  if (partitioned && options.unlogged)
    return "Partitioned tables can't be unlogged; make each partition unlogged instead"
  if (partitioned && options.parameters.some((p) => p.name.trim()))
    return 'Partitioned tables take no storage parameters; set them on each partition'

  const seen = new Set<string>()
  for (const p of options.parameters) {
    const name = p.name.trim().toLowerCase()
    if (!name && !p.value.trim()) continue
    if (!PARAMETER_NAME.test(name))
      return `${p.name.trim() || 'A parameter'} isn't a valid storage parameter name`
    if (!p.value.trim()) return `Enter a value for ${name}`
    if (!PARAMETER_VALUE.test(p.value.trim()))
      return `${p.value.trim()} isn't a valid value for ${name}`
    if (seen.has(name)) return `${name} is set twice`
    seen.add(name)
  }

  for (const x of newExclusions(options.exclusions)) {
    const name = exclusionName(draft, x)
    if (!x.elements.length || x.elements.some((e) => !e.expression.trim()))
      return `Enter the columns or expressions of exclusion constraint ${name}`
    const bad = x.elements.find((e) => !OPERATOR.test(e.operator.trim()))
    if (bad) return `Enter an operator such as = or && for ${bad.expression.trim()} in ${name}`
    if (x.method.trim() && !/^\w+$/.test(x.method.trim())) return `Invalid index method for ${name}`
    if (partitioned) {
      if (!canExcludeOnPartitioned(context))
        return `PostgreSQL ${majorOf(context.version)} can't add exclusion constraints to partitioned tables (17+ can)`
      const missing = keyNames.filter(
        (k) => !x.elements.some((e) => e.expression.trim() === k && e.operator.trim() === '=')
      )
      if (missing.length)
        return `Exclusion constraint ${name} must compare the partition key (${missing.join(', ')}) with =`
    }
  }
  const gist = needsBtreeGist(draft, options)
  if (gist.length && !context.btreeGist.installed) {
    if (!context.btreeGist.available)
      return `${exclusionName(draft, gist[0])} needs the btree_gist extension, which this server doesn't have; use range columns or install it`
    if (!options.installBtreeGist)
      return `${exclusionName(draft, gist[0])} compares scalar values with = under GiST, which needs the btree_gist extension`
  }

  for (const p of options.partitions) {
    const label =
      p.name.trim() || (p.mode === 'create' ? 'the new partition' : 'the attached table')
    if (!partitioned) return 'Pick a partitioning strategy before adding partitions'
    if (!p.name.trim())
      return p.mode === 'create' ? 'Enter a name for the new partition' : 'Pick the table to attach'
    if (p.isDefault && strategy !== 'HASH') continue
    if (strategy === 'RANGE' && (!p.from.trim() || !p.to.trim()))
      return `Enter the FROM and TO bounds of ${label}`
    if (strategy === 'LIST' && !p.values.trim()) return `Enter the values of ${label}`
    if (strategy === 'HASH') {
      if (!INTEGER.test(p.modulus.trim()) || !INTEGER.test(p.remainder.trim()))
        return `Enter a whole-number modulus and remainder for ${label}`
      if (Number(p.remainder) >= Number(p.modulus) || Number(p.modulus) === 0)
        return `The remainder of ${label} must be less than its modulus`
    }
  }
  if (options.partitions.filter((p) => p.isDefault && strategy !== 'HASH').length > 1)
    return 'A table can have only one default partition'

  if (detached(options).some((p) => p.concurrently)) {
    if (!canDetachConcurrently(context))
      return `PostgreSQL ${majorOf(context.version)} can't detach partitions concurrently (14+ can)`
    if (statements.length > 1)
      return "DETACH PARTITION … CONCURRENTLY can't run in a transaction; detach one partition on its own, with no other changes"
    if (options.existingPartitions.some((p) => p.bound === 'DEFAULT' && !p.detach))
      return "Partitions can't be detached concurrently while the table has a default partition"
  }
  return null
}

/** Lock-heavy or risky operations, for the warning list in the preview. */
export function pgTableOptionWarnings(
  draft: TableDraft,
  options: PgTableOptions,
  context: PgTableContext
): string[] {
  const warnings: string[] = []
  const creating = !draft.original
  const was = context.original
  const parent = draft.name.trim()
  const hasDefault = (creating ? [] : options.existingPartitions).some(
    (p) => p.bound === 'DEFAULT' && !p.detach
  )
  if (wantsBtreeGist(draft, options, context))
    warnings.push(
      'Installs the btree_gist extension, which GiST exclusion constraints need to compare scalar values with ='
    )
  if (!creating && was) {
    const partitioned = !!context.partitionedBy
    if (options.unlogged !== was.unlogged)
      warnings.push(
        `SET ${options.unlogged ? 'UNLOGGED' : 'LOGGED'} rewrites the table under an ACCESS EXCLUSIVE lock, blocking reads and writes until it finishes`
      )
    if (options.tablespace !== was.tablespace && !partitioned)
      warnings.push(
        'SET TABLESPACE rewrites the table under an ACCESS EXCLUSIVE lock, blocking reads and writes until it finishes; its indexes stay where they are'
      )
    for (const x of newExclusions(options.exclusions))
      warnings.push(
        `Adding ${exclusionName(draft, x)} builds its index under an ACCESS EXCLUSIVE lock and fails if existing rows conflict`
      )
    for (const p of detached(options))
      warnings.push(
        p.concurrently
          ? `Detaching ${p.name} concurrently runs outside a transaction; if it's interrupted, finish it with ALTER TABLE … DETACH PARTITION ${p.name} FINALIZE`
          : `Detaching ${p.name} takes an ACCESS EXCLUSIVE lock on ${parent}${canDetachConcurrently(context) ? '; CONCURRENTLY avoids blocking queries' : ''}`
      )
  }
  if (options.unlogged && (creating || !was?.unlogged))
    warnings.push("Unlogged tables are emptied after a crash and aren't copied to standbys")
  for (const p of options.partitions) {
    if (p.mode === 'attach')
      warnings.push(
        `Attaching ${p.name.trim() || 'a table'} scans it to check its bound under an ACCESS EXCLUSIVE lock (a matching CHECK constraint skips the scan)${hasDefault ? '; the default partition is scanned too' : ''}`
      )
    else if (hasDefault)
      warnings.push(
        `Creating ${p.name.trim() || 'a partition'} scans the default partition for rows that belong in it`
      )
  }
  return warnings
}
