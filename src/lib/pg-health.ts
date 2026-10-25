import type { Cell, ColumnMeta, ResultSet } from './api'
import { qualified, quoteIdent, type TableRef } from './sql'

/**
 * PostgreSQL table and index health and the progress of long-running commands,
 * for the server tab. Everything reads the statistics views, so it needs no
 * extension; pgstattuple is only offered for exact bloat when it's installed.
 */

/** What the health panels need to know about the server before building their SQL. */
export interface PgHealthContext {
  /** server_version_num, e.g. 170002 */
  version: number
  /** When this database's statistics were last reset, or null if never */
  statsReset: string | null
  /** Superuser or pg_read_all_stats: other roles' sessions and progress show in full */
  allStats: boolean
  /** pgstattuple is installed in this database */
  pgstattuple: boolean
  freezeMaxAge: number
}

export const HEALTH_CONTEXT_SQL = `SELECT current_setting('server_version_num')::int AS version,
  (SELECT stats_reset FROM pg_stat_database WHERE datname = current_database()) AS stats_reset,
  (SELECT rolsuper FROM pg_roles WHERE rolname = current_user)
    OR pg_has_role(current_user, 'pg_read_all_stats', 'USAGE') AS all_stats,
  EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgstattuple') AS pgstattuple,
  current_setting('autovacuum_freeze_max_age')::bigint AS freeze_max_age`

export function parseHealthContext(set: ResultSet | null | undefined): PgHealthContext | null {
  const row = set?.rows[0]
  if (!set || !row) return null
  const get = (name: string): Cell => row[set.columns.findIndex((c) => c.name === name)] ?? null
  return {
    version: Number(get('version')) || 0,
    statsReset: typeof get('stats_reset') === 'string' ? (get('stats_reset') as string) : null,
    allStats: truthy(get('all_stats')),
    pgstattuple: truthy(get('pgstattuple')),
    freezeMaxAge: Number(get('freeze_max_age')) || 200_000_000
  }
}

function truthy(v: Cell): boolean {
  return v === true || v === 't' || v === 'true'
}

/* ---------- Table health ---------- */

/**
 * Statistics-based bloat estimate per table (the widely used ioguix/check_pgactivity
 * query): the pages the table would need for its row count and average row width
 * from pg_stats, against the pages it has. Null where the estimate can't be made:
 * never analyzed, no readable column statistics, or `name` columns.
 */
const BLOAT_CTE = `bloat AS (
  SELECT tblid,
    CASE WHEN is_na OR reltuples < 0 THEN NULL
      ELSE greatest(tblpages - est_pages_ff, 0) * bs END AS bloat_bytes,
    CASE WHEN is_na OR reltuples < 0 OR tblpages = 0 THEN NULL
      ELSE round((100 * greatest(tblpages - est_pages_ff, 0) / tblpages)::numeric, 1) END AS bloat_pct
  FROM (
    SELECT tblid, is_na, reltuples, bs, heappages + toastpages AS tblpages,
      ceil(reltuples / ((bs - 24) * fillfactor / (tpl_size * 100))) + ceil(toasttuples / 4) AS est_pages_ff
    FROM (
      SELECT tblid, is_na, reltuples, toasttuples, heappages, toastpages, bs, fillfactor,
        (4 + tpl_hdr_size + tpl_data_size + 16
          - CASE WHEN tpl_hdr_size % 8 = 0 THEN 8 ELSE tpl_hdr_size % 8 END
          - CASE WHEN ceil(tpl_data_size)::int % 8 = 0 THEN 8 ELSE ceil(tpl_data_size)::int % 8 END
        ) AS tpl_size
      FROM (
        SELECT tbl.oid AS tblid, tbl.reltuples, tbl.relpages AS heappages,
          coalesce(toast.relpages, 0) AS toastpages, coalesce(toast.reltuples, 0) AS toasttuples,
          coalesce(substring(array_to_string(tbl.reloptions, ' ') FROM 'fillfactor=([0-9]+)')::smallint, 100) AS fillfactor,
          current_setting('block_size')::numeric AS bs,
          23 + CASE WHEN max(coalesce(s.null_frac, 0)) > 0 THEN (7 + count(s.attname)) / 8 ELSE 0 END AS tpl_hdr_size,
          sum((1 - coalesce(s.null_frac, 0)) * coalesce(s.avg_width, 0)) AS tpl_data_size,
          bool_or(att.atttypid = 'pg_catalog.name'::regtype) OR count(*) <> count(s.attname) AS is_na
        FROM pg_attribute att
        JOIN pg_class tbl ON tbl.oid = att.attrelid
        JOIN pg_namespace ns ON ns.oid = tbl.relnamespace
        LEFT JOIN pg_stats s ON s.schemaname = ns.nspname AND s.tablename = tbl.relname
          AND s.inherited = false AND s.attname = att.attname
        LEFT JOIN pg_class toast ON toast.oid = tbl.reltoastrelid
        WHERE att.attnum > 0 AND NOT att.attisdropped AND tbl.relkind IN ('r', 'm')
          AND ns.nspname NOT IN ('pg_catalog', 'information_schema') AND ns.nspname !~ '^pg_toast'
        GROUP BY tbl.oid, tbl.reltuples, tbl.relpages, toast.relpages, toast.reltuples, tbl.reloptions
      ) a
    ) b
  ) c
)`

/** One row per user table: tuples, vacuum and analyze history, wraparound age, estimated bloat, size. */
export function tableHealthSql(version: number): string {
  // last_seq_scan / last_idx_scan arrived in PostgreSQL 16
  const lastScan = version >= 160000 ? ', s.last_seq_scan, s.last_idx_scan' : ''
  return `WITH ${BLOAT_CTE},
opts AS (
  SELECT c.oid,
    (SELECT option_value FROM pg_options_to_table(c.reloptions) WHERE option_name = 'autovacuum_enabled') AS av_enabled,
    (SELECT option_value::bigint FROM pg_options_to_table(c.reloptions) WHERE option_name = 'autovacuum_freeze_max_age') AS freeze_max_age,
    (SELECT option_value::numeric FROM pg_options_to_table(c.reloptions) WHERE option_name = 'autovacuum_vacuum_scale_factor') AS vac_scale,
    (SELECT option_value::bigint FROM pg_options_to_table(c.reloptions) WHERE option_name = 'autovacuum_vacuum_threshold') AS vac_threshold
  FROM pg_class c WHERE c.relkind IN ('r', 'm', 'p')
)
SELECT s.schemaname AS schema, s.relname AS "table",
  pg_size_pretty(pg_total_relation_size(s.relid)) AS total_size,
  pg_total_relation_size(s.relid) AS total_bytes,
  s.n_live_tup AS live_tuples, s.n_dead_tup AS dead_tuples,
  round(100.0 * s.n_dead_tup / nullif(s.n_live_tup + s.n_dead_tup, 0), 1) AS dead_pct,
  s.n_mod_since_analyze AS modified_since_analyze, s.n_ins_since_vacuum AS inserted_since_vacuum,
  s.last_vacuum, s.last_autovacuum, s.last_analyze, s.last_autoanalyze,
  s.vacuum_count, s.autovacuum_count, s.analyze_count, s.autoanalyze_count,
  CASE WHEN c.relkind = 'p' THEN NULL ELSE age(c.relfrozenxid) END AS xid_age,
  least(coalesce(o.freeze_max_age, current_setting('autovacuum_freeze_max_age')::bigint),
    current_setting('autovacuum_freeze_max_age')::bigint) AS freeze_max_age,
  pg_size_pretty(b.bloat_bytes::bigint) AS est_bloat, b.bloat_bytes::bigint AS est_bloat_bytes,
  b.bloat_pct AS est_bloat_pct,
  round(coalesce(o.vac_threshold, current_setting('autovacuum_vacuum_threshold')::bigint)
    + coalesce(o.vac_scale, current_setting('autovacuum_vacuum_scale_factor')::numeric)
      * greatest(c.reltuples, 0)::numeric)::bigint AS autovacuum_at,
  coalesce(o.av_enabled, 'on') NOT IN ('off', 'false', 'no', '0') AS autovacuum,
  s.seq_scan, s.idx_scan${lastScan}
FROM pg_stat_user_tables s
JOIN pg_class c ON c.oid = s.relid
LEFT JOIN opts o ON o.oid = s.relid
LEFT JOIN bloat b ON b.tblid = s.relid
ORDER BY s.n_dead_tup DESC, s.schemaname, s.relname`
}

/** Dead rows above this share of a table, or estimated bloat above it, flag the table. */
export const DEAD_PCT_WARN = 20
export const BLOAT_PCT_WARN = 30
/** Wraparound age as a share of autovacuum_freeze_max_age that flags a table. */
export const FREEZE_WARN = 0.75

export type HealthFlag = 'vacuum' | 'analyze' | 'wraparound' | 'bloat' | 'autovacuum-off'

export const FLAG_LABEL: Record<HealthFlag, string> = {
  vacuum: 'needs vacuum',
  analyze: 'needs analyze',
  wraparound: 'wraparound',
  bloat: 'bloated (est.)',
  'autovacuum-off': 'autovacuum off'
}

type RowReader = (name: string) => Cell

function num(v: Cell): number | null {
  if (v === null || typeof v === 'boolean') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** What's worth a look in a table-health row. */
export function healthFlags(get: RowReader): HealthFlag[] {
  const flags: HealthFlag[] = []
  const dead = num(get('dead_tuples')) ?? 0
  const deadPct = num(get('dead_pct')) ?? 0
  const live = num(get('live_tuples')) ?? 0
  const at = num(get('autovacuum_at'))
  if (dead > 0 && (deadPct >= DEAD_PCT_WARN || (at !== null && dead > at))) flags.push('vacuum')
  const modified = num(get('modified_since_analyze')) ?? 0
  const analyzed = get('last_analyze') !== null || get('last_autoanalyze') !== null
  if ((modified > 0 && !analyzed) || (live > 0 && modified > Math.max(50, 0.2 * live)))
    flags.push('analyze')
  const age = num(get('xid_age'))
  const max = num(get('freeze_max_age'))
  if (age !== null && max && age >= FREEZE_WARN * max) flags.push('wraparound')
  if ((num(get('est_bloat_pct')) ?? 0) >= BLOAT_PCT_WARN) flags.push('bloat')
  if (truthy(get('autovacuum')) === false && get('autovacuum') !== null)
    flags.push('autovacuum-off')
  return flags
}

/** The rows' reader for column `name`, or null when the column is missing. */
export function reader(set: ResultSet, row: number): RowReader {
  const at = new Map(set.columns.map((c, i) => [c.name, i]))
  return (name) => {
    const i = at.get(name)
    return i === undefined ? null : (set.rows[row]?.[i] ?? null)
  }
}

/**
 * The table-health grid: a leading `attention` column of flags, the wraparound
 * age as a share of the freeze limit, and only the tables a filter keeps.
 */
export function withHealthFlags(set: ResultSet, onlyFlagged: boolean): ResultSet {
  const rows: Cell[][] = []
  for (let i = 0; i < set.rows.length; i++) {
    const get = reader(set, i)
    const flags = healthFlags(get)
    if (onlyFlagged && !flags.length) continue
    const age = num(get('xid_age'))
    const max = num(get('freeze_max_age'))
    const freezePct = age !== null && max ? (Math.round((1000 * age) / max) / 10).toFixed(1) : null
    const row = set.rows[i]
    // xid_age is followed by the share of the freeze limit it has used
    const ageCol = set.columns.findIndex((c) => c.name === 'xid_age')
    const out = [flags.map((f) => FLAG_LABEL[f]).join(', ') || null, ...row]
    if (ageCol >= 0) out.splice(ageCol + 2, 0, freezePct)
    rows.push(out)
  }
  const columns: ColumnMeta[] = [{ name: 'attention', typeName: 'text' }, ...set.columns]
  const ageCol = set.columns.findIndex((c) => c.name === 'xid_age')
  if (ageCol >= 0) columns.splice(ageCol + 2, 0, { name: 'freeze_limit_pct', typeName: 'numeric' })
  return { columns, rows, rowCount: rows.length, truncated: set.truncated }
}

/** The table a health or index row is about. */
export function rowTable(set: ResultSet, row: number): TableRef | null {
  const get = reader(set, row)
  const schema = get('schema')
  const name = get('table')
  if (typeof name !== 'string') return null
  return { schema: typeof schema === 'string' ? schema : null, name }
}

/** pgstattuple's exact numbers for one table, to open in a query tab. */
export function exactBloatSql(table: TableRef): string {
  const literal = qualified('postgres', table).replace(/'/g, "''")
  return `-- Reads the whole table: exact live, dead and free space
SELECT * FROM pgstattuple('${literal}');`
}

/* ---------- Index usage ---------- */

/** Every user index with its scans, size, validity and what it's made of, for duplicate detection. */
export function indexUsageSql(version: number): string {
  const lastScan = version >= 160000 ? 's.last_idx_scan' : 'NULL::timestamptz AS last_idx_scan'
  return `SELECT s.schemaname AS schema, s.relname AS "table", s.indexrelname AS "index",
  pg_size_pretty(pg_relation_size(s.indexrelid)) AS size, pg_relation_size(s.indexrelid) AS size_bytes,
  s.idx_scan, s.idx_tup_read, s.idx_tup_fetch, ${lastScan},
  i.indisvalid AS valid, i.indisprimary AS "primary", i.indisunique AS "unique",
  con.conname AS "constraint", con.contype::text AS constraint_type,
  pg_get_indexdef(s.indexrelid) AS definition,
  i.indrelid::text AS table_oid, am.amname AS method,
  (SELECT string_agg(k::text, ' ') FROM unnest(i.indkey[0:i.indnkeyatts - 1]) k) AS key_columns,
  i.indclass[0:i.indnkeyatts - 1]::text AS key_opclasses,
  pg_get_expr(i.indexprs, i.indrelid) AS expressions,
  pg_get_expr(i.indpred, i.indrelid) AS predicate
FROM pg_stat_user_indexes s
JOIN pg_index i ON i.indexrelid = s.indexrelid
JOIN pg_class ic ON ic.oid = s.indexrelid
JOIN pg_am am ON am.oid = ic.relam
LEFT JOIN pg_constraint con ON con.conindid = s.indexrelid AND con.contype IN ('p', 'u', 'x')
ORDER BY pg_relation_size(s.indexrelid) DESC, s.schemaname, s.indexrelname`
}

export type IndexIssue = 'invalid' | 'unused' | 'duplicate' | 'redundant'

export interface IndexIssues {
  issues: IndexIssue[]
  /** The other index a duplicate or redundant one is covered by */
  of: Partial<Record<IndexIssue, string>>
}

export interface IndexRow {
  schema: string
  table: string
  index: string
  scans: number
  valid: boolean
  /** Primary key, unique, or backing a constraint: dropping it changes what the table enforces */
  enforces: boolean
  constraint: string | null
  tableOid: string
  method: string
  keys: string[]
  opclasses: string
  expressions: string | null
  predicate: string | null
}

export function indexRows(set: ResultSet): IndexRow[] {
  return set.rows.map((_, i) => {
    const get = reader(set, i)
    const text = (n: string): string | null => {
      const v = get(n)
      return typeof v === 'string' ? v : null
    }
    return {
      schema: text('schema') ?? '',
      table: text('table') ?? '',
      index: text('index') ?? '',
      scans: num(get('idx_scan')) ?? 0,
      valid: truthy(get('valid')),
      enforces: truthy(get('primary')) || truthy(get('unique')) || text('constraint') !== null,
      constraint: text('constraint'),
      tableOid: text('table_oid') ?? '',
      method: text('method') ?? '',
      keys: (text('key_columns') ?? '').split(' ').filter(Boolean),
      opclasses: text('key_opclasses') ?? '',
      expressions: text('expressions'),
      predicate: text('predicate')
    }
  })
}

/**
 * Each index's problems, keyed by its row, with the index it duplicates where there is one.
 * Two indexes match when they're on the same table with the same access method,
 * expressions and predicate; equal keys make a duplicate, and keys that are a
 * leading prefix of another index's make the shorter one redundant (unless it
 * enforces uniqueness, which the longer one can't).
 */
export function indexIssues(rows: IndexRow[]): Map<number, IndexIssues> {
  const out = new Map<number, IndexIssues>()
  const add = (i: number, issue: IndexIssue, of?: string): void => {
    const entry = out.get(i) ?? { issues: [], of: {} }
    if (!entry.issues.includes(issue)) entry.issues.push(issue)
    if (of && !entry.of[issue]) entry.of[issue] = of
    out.set(i, entry)
  }
  const opclassList = (r: IndexRow): string[] => r.opclasses.replace(/[{}]/g, '').split(/[\s,]+/)
  rows.forEach((r, i) => {
    if (!r.valid) add(i, 'invalid')
    else if (r.scans === 0 && !r.enforces) add(i, 'unused')
  })
  rows.forEach((a, i) => {
    if (!a.valid || !a.keys.length) return
    rows.forEach((b, j) => {
      if (i === j || !b.valid || a.tableOid !== b.tableOid || a.method !== b.method) return
      if (a.expressions !== b.expressions || a.predicate !== b.predicate) return
      if (a.keys.length > b.keys.length) return
      const ao = opclassList(a)
      const bo = opclassList(b)
      if (!a.keys.every((k, n) => k === b.keys[n] && ao[n] === bo[n])) return
      if (a.keys.length === b.keys.length) {
        // Of two identical indexes, flag the one that doesn't enforce anything, else the later one
        const keepA = (a.enforces && !b.enforces) || (a.enforces === b.enforces && i < j)
        if (!keepA) add(i, 'duplicate', b.index)
      } else if (!a.enforces) add(i, 'redundant', b.index)
    })
  })
  return out
}

export const ISSUE_LABEL: Record<IndexIssue, string> = {
  invalid: 'invalid',
  unused: 'unused',
  duplicate: 'duplicate of',
  redundant: 'prefix of'
}

export function issueLabel(entry: IndexIssues): string {
  return entry.issues
    .map((x) => (entry.of[x] ? `${ISSUE_LABEL[x]} ${entry.of[x]}` : ISSUE_LABEL[x]))
    .join(', ')
}

export type IndexFilter = 'all' | 'problems' | IndexIssue

/**
 * The index grid: a leading `issue` column, the matching columns hidden, filtered
 * by issue; `source` maps each grid row back to its row in `set`.
 */
export function withIndexIssues(
  set: ResultSet,
  filter: IndexFilter
): { set: ResultSet; source: number[] } {
  const rows = indexRows(set)
  const issues = indexIssues(rows)
  const hidden = new Set([
    'table_oid',
    'method',
    'key_columns',
    'key_opclasses',
    'expressions',
    'predicate'
  ])
  const keep = set.columns.map((c, i) => (hidden.has(c.name) ? -1 : i)).filter((i) => i >= 0)
  const out: Cell[][] = []
  const source: number[] = []
  set.rows.forEach((row, i) => {
    const entry = issues.get(i)
    if (filter === 'problems' && !entry) return
    if (filter !== 'all' && filter !== 'problems' && !entry?.issues.includes(filter)) return
    const label = entry ? issueLabel(entry) : null
    out.push([label, ...keep.map((c) => row[c])])
    source.push(i)
  })
  return {
    set: {
      columns: [{ name: 'issue', typeName: 'text' }, ...keep.map((c) => set.columns[c])],
      rows: out,
      rowCount: out.length,
      truncated: set.truncated
    },
    source
  }
}

export interface DropIndexOptions {
  concurrently: boolean
}

/**
 * The script that removes an index, for the user to review and run. Indexes
 * behind a constraint can only go with the constraint, so that's scripted instead.
 */
export function dropIndexSql(index: IndexRow, options: DropIndexOptions): string {
  const target = qualified('postgres', { schema: index.schema, name: index.index })
  if (index.constraint) {
    const table = qualified('postgres', { schema: index.schema, name: index.table })
    return `-- ${quoteIdent('postgres', index.index)} backs constraint ${quoteIdent('postgres', index.constraint)}:
-- dropping it removes what the constraint enforces (and fails if foreign keys depend on it)
ALTER TABLE ${table} DROP CONSTRAINT ${quoteIdent('postgres', index.constraint)};`
  }
  if (options.concurrently)
    return `-- CONCURRENTLY doesn't block writes but can't run inside a transaction block
DROP INDEX CONCURRENTLY IF EXISTS ${target};`
  return `DROP INDEX IF EXISTS ${target};`
}

/** Rebuilds an invalid index (left behind by a failed CREATE INDEX CONCURRENTLY). */
export function reindexSql(index: IndexRow): string {
  return `-- CONCURRENTLY can't run inside a transaction block
REINDEX INDEX CONCURRENTLY ${qualified('postgres', { schema: index.schema, name: index.index })};`
}

/* ---------- Progress ---------- */

/**
 * Running VACUUM, ANALYZE, CREATE INDEX, CLUSTER, COPY (PostgreSQL 14+) and base
 * backups, one row each with a common shape: `done` of `total` in `unit`, and the
 * session from pg_stat_activity. Relation names resolve only in this database.
 */
export function progressSql(version: number): string {
  const rel = (col: string): string =>
    `CASE WHEN p.datid = (SELECT oid FROM pg_database WHERE datname = current_database())
      THEN ${col}::regclass::text ELSE ${col}::text END`
  // PostgreSQL 17 counts indexes while vacuuming them
  const vacuumIndexes =
    version >= 170000
      ? `WHEN p.phase = 'vacuuming indexes' AND p.indexes_total > 0 THEN p.indexes_processed`
      : ''
  const vacuumIndexesTotal =
    version >= 170000
      ? `WHEN p.phase = 'vacuuming indexes' AND p.indexes_total > 0 THEN p.indexes_total`
      : ''
  const vacuumUnit =
    version >= 170000
      ? `CASE WHEN p.phase = 'vacuuming indexes' AND p.indexes_total > 0 THEN 'indexes' ELSE 'blocks' END`
      : `'blocks'`
  const parts = [
    `SELECT p.pid, p.datname AS "database", 'VACUUM' AS command, p.phase,
  ${rel('p.relid')} AS relation,
  CASE ${vacuumIndexes} WHEN p.phase = 'vacuuming heap' THEN p.heap_blks_vacuumed ELSE p.heap_blks_scanned END AS done,
  ${vacuumIndexesTotal ? `CASE ${vacuumIndexesTotal} ELSE p.heap_blks_total END` : 'p.heap_blks_total'} AS total, ${vacuumUnit} AS unit,
  'index passes: ' || p.index_vacuum_count AS detail
FROM pg_stat_progress_vacuum p`,
    `SELECT p.pid, p.datname, 'ANALYZE', p.phase, ${rel('p.relid')},
  CASE WHEN p.phase = 'computing extended statistics' THEN p.ext_stats_computed ELSE p.sample_blks_scanned END,
  CASE WHEN p.phase = 'computing extended statistics' THEN p.ext_stats_total ELSE p.sample_blks_total END,
  CASE WHEN p.phase = 'computing extended statistics' THEN 'statistics' ELSE 'sample blocks' END,
  CASE WHEN p.child_tables_total > 0 THEN 'child tables: ' || p.child_tables_done || '/' || p.child_tables_total END
FROM pg_stat_progress_analyze p`,
    `SELECT p.pid, p.datname, coalesce(p.command, 'CREATE INDEX'), p.phase,
  ${rel('p.relid')} || CASE WHEN p.index_relid <> 0 THEN ' → ' || ${rel('p.index_relid')} ELSE '' END,
  CASE WHEN p.blocks_total > 0 THEN p.blocks_done WHEN p.tuples_total > 0 THEN p.tuples_done
    WHEN p.lockers_total > 0 THEN p.lockers_done END,
  CASE WHEN p.blocks_total > 0 THEN p.blocks_total WHEN p.tuples_total > 0 THEN p.tuples_total
    WHEN p.lockers_total > 0 THEN p.lockers_total END,
  CASE WHEN p.blocks_total > 0 THEN 'blocks' WHEN p.tuples_total > 0 THEN 'tuples'
    WHEN p.lockers_total > 0 THEN 'lockers waited for' END,
  CASE WHEN p.partitions_total > 0 THEN 'partitions: ' || p.partitions_done || '/' || p.partitions_total END
FROM pg_stat_progress_create_index p`,
    `SELECT p.pid, p.datname, coalesce(p.command, 'CLUSTER'), p.phase, ${rel('p.relid')},
  p.heap_blks_scanned, p.heap_blks_total, 'blocks',
  'tuples written: ' || p.heap_tuples_written
FROM pg_stat_progress_cluster p`
  ]
  if (version >= 140000)
    parts.push(`SELECT p.pid, p.datname, coalesce(p.command, 'COPY'), p."type", ${rel('p.relid')},
  p.bytes_processed, nullif(p.bytes_total, 0), 'bytes',
  'tuples: ' || p.tuples_processed
FROM pg_stat_progress_copy p`)
  parts.push(`SELECT p.pid, NULL, 'BASE BACKUP', p.phase, NULL,
  p.backup_streamed, p.backup_total, 'bytes',
  'tablespaces: ' || p.tablespaces_streamed || '/' || p.tablespaces_total
FROM pg_stat_progress_basebackup p`)
  // Other roles' rows come back with only pid and database unless the user may read all stats
  return `SELECT g.pid, g.command, coalesce(g.phase, '(hidden: needs pg_read_all_stats)') AS phase, g.relation,
  round(100.0 * g.done / nullif(g.total, 0), 1) AS percent, g.done, g.total, g.unit, g.detail,
  g."database", a.usename AS "user", now() - a.xact_start AS running_for,
  a.wait_event_type AS waiting_on, left(a.query, 300) AS query
FROM (
${parts.join('\nUNION ALL\n')}
) g
LEFT JOIN pg_stat_activity a ON a.pid = g.pid
ORDER BY a.xact_start NULLS LAST, g.pid`
}
