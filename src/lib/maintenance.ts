import type { Engine, ResultSet } from './api'
import type { Dialect } from './engines'
import { qualified, quoteIdent, type TableRef } from './sql'

export type MaintenanceTask =
  | 'vacuum'
  | 'analyze'
  | 'reindex'
  | 'optimize'
  | 'check'
  | 'repair'
  | 'checkdb'
  | 'statistics'
  | 'rebuild'
  | 'reorganize'
  | 'shrink'
  | 'integrity'
  | 'pragma-optimize'
  | 'checkpoint'
  | 'validate'
  | 'compact'

export type MaintenanceOption =
  | 'full'
  | 'analyze'
  | 'freeze'
  | 'verbose'
  | 'concurrently'
  | 'local'
  | 'extended'
  | 'physicalOnly'
  | 'fullScan'
  | 'online'
  | 'quick'

export interface MaintenanceTaskInfo {
  value: MaintenanceTask
  label: string
  description: string
  /** What the task does in more depth, shown as its tooltip */
  hint: string
  /** Options shown for the task, in order */
  options: MaintenanceOption[]
  /** Whether the task can be limited to chosen tables (or collections) */
  perTable: boolean
  /** Runs once per table even for the whole database (the engine has no database-wide form) */
  eachTable?: boolean
}

export interface MaintenanceDraft {
  task: MaintenanceTask
  scope: 'all' | 'tables'
  /** Chosen tables when `scope` is 'tables' */
  tables: TableRef[]
  options: Partial<Record<MaintenanceOption, boolean>>
}

/** One statement (or MongoDB command) run on its own, so progress shows and a failure doesn't stop the rest. */
export type MaintenanceStep =
  { label: string; sql: string } | { label: string; command: Record<string, unknown> }

export interface OptionText {
  label: string
  description: string
  /** What the option does in more depth, shown as its tooltip */
  hint: string
}

export const OPTION_INFO: Record<MaintenanceOption, OptionText> = {
  full: {
    label: 'Full',
    description:
      'Rewrites each table to return space to the operating system; takes an exclusive lock',
    hint: 'VACUUM FULL writes a new copy of each table without dead rows and swaps it in, returning space to the operating system. Holds an ACCESS EXCLUSIVE lock (no reads or writes) on each table while it runs.'
  },
  analyze: {
    label: 'Analyze',
    description: 'Also update planner statistics',
    hint: "Adds ANALYZE, so each table's planner statistics are refreshed right after it's vacuumed."
  },
  freeze: {
    label: 'Freeze',
    description: 'Freeze row versions aggressively',
    hint: "Adds FREEZE: marks every row as frozen now instead of waiting for autovacuum's age thresholds. Useful before heavy write load, or to head off transaction ID wraparound."
  },
  verbose: {
    label: 'Verbose',
    description: 'Report progress for each table',
    hint: 'Adds VERBOSE: prints a report for each table and index (pages and rows removed, time taken) in the output.'
  },
  concurrently: {
    label: 'Concurrently',
    description: 'Rebuild without blocking writes; slower, PostgreSQL 12 and later',
    hint: 'Adds CONCURRENTLY: builds each new index alongside the old one so reads and writes continue, then swaps them. Slower and uses more resources, and system catalogs are skipped. PostgreSQL 12 and later.'
  },
  local: {
    label: 'Skip the binary log',
    description: 'NO_WRITE_TO_BINLOG: don’t replicate the statement to replicas',
    hint: "Adds NO_WRITE_TO_BINLOG: the statement isn't written to the binary log, so replicas don't run it too."
  },
  extended: {
    label: 'Extended',
    description: 'Check every row and key thoroughly; slow on big tables',
    hint: 'Adds EXTENDED: does a full key lookup for every key in every row, so the table is fully consistent. Much slower than the default check.'
  },
  physicalOnly: {
    label: 'Physical only',
    description: 'Check page and record structure only; much faster on large databases',
    hint: 'Adds PHYSICAL_ONLY: checks only page structure, record headers and allocation, skipping the logical checks. Much faster on large databases, and still catches torn pages and checksum failures.'
  },
  fullScan: {
    label: 'Full scan',
    description: 'Read every row instead of sampling; slower but exact',
    hint: 'Adds WITH FULLSCAN: reads every row to build the statistics instead of a sample. Exact, but slower on large tables. Runs one statement per table.'
  },
  online: {
    label: 'Online',
    description: 'Keep tables available during the rebuild (Enterprise, Developer and Azure)',
    hint: 'Adds WITH (ONLINE = ON): tables stay readable and writable during the rebuild, with only short locks at the start and end. Needs Enterprise or Developer edition, or Azure SQL.'
  },
  quick: {
    label: 'Quick',
    description: 'quick_check: skip index consistency checks',
    hint: "Uses PRAGMA quick_check instead: skips checking that index contents match the tables, so it's much faster but finds less."
  }
}

const TASKS: Record<Engine, MaintenanceTaskInfo[]> = {
  postgres: [
    {
      value: 'vacuum',
      label: 'Vacuum',
      description: 'Reclaim space from dead rows and keep the visibility map current',
      hint: "Runs VACUUM. Updates and deletes leave dead row versions behind; vacuum marks their space reusable, updates the visibility map so index-only scans work, and prevents transaction ID wraparound. Autovacuum normally does this, so run it by hand after bulk deletes or updates. It doesn't block reads or writes unless Full is on.",
      options: ['analyze', 'full', 'freeze', 'verbose'],
      perTable: true
    },
    {
      value: 'analyze',
      label: 'Analyze',
      description: 'Refresh the statistics the query planner relies on',
      hint: 'Runs ANALYZE. Samples each table and stores column statistics (distinct values, common values, histograms) that the planner uses to estimate row counts. Run it after bulk loads or big data changes when query plans look wrong. Takes only a light lock.',
      options: ['verbose'],
      perTable: true
    },
    {
      value: 'reindex',
      label: 'Reindex',
      description: 'Rebuild indexes to remove bloat or recover from corruption',
      hint: 'Runs REINDEX. Rebuilds every index on the database or chosen tables from the table data. Use it to shrink bloated indexes after heavy updates and deletes, or to repair an index that is corrupt or was left invalid by a failed concurrent build.',
      options: ['concurrently', 'verbose'],
      perTable: true
    }
  ],
  mysql: [
    {
      value: 'optimize',
      label: 'Optimize',
      description: 'Rebuild tables to defragment data and reclaim unused space',
      hint: "Runs OPTIMIZE TABLE on each table. For InnoDB this recreates the table and its indexes and then analyzes it, which defragments the data and returns space freed by deletes. Worth running after deleting or updating a large share of a table's rows.",
      options: ['local'],
      perTable: true,
      eachTable: true
    },
    {
      value: 'analyze',
      label: 'Analyze',
      description: 'Refresh index statistics used by the optimizer',
      hint: 'Runs ANALYZE TABLE on each table. Recalculates the index key distribution the optimizer uses to choose indexes and join order. Fast, and it only briefly locks each table. Run it when plans look wrong after big data changes.',
      options: ['local'],
      perTable: true,
      eachTable: true
    },
    {
      value: 'check',
      label: 'Check',
      description: 'Look for errors in tables and their indexes',
      hint: "Runs CHECK TABLE on each table. Reads tables and indexes looking for corruption and reports OK or the errors found. Read-only, so it's safe to run at any time; repair or restore any tables it reports.",
      options: ['extended'],
      perTable: true,
      eachTable: true
    },
    {
      value: 'repair',
      label: 'Repair',
      description: 'Repair damaged MyISAM, ARCHIVE and CSV tables',
      hint: "Runs REPAIR TABLE on each table. Rebuilds damaged MyISAM, ARCHIVE and CSV tables and their indexes. InnoDB doesn't support it; recover InnoDB tables by restoring a backup or dumping and reloading them. Back up the table first, since a repair can lose rows.",
      options: ['extended', 'local'],
      perTable: true,
      eachTable: true
    }
  ],
  mssql: [
    {
      value: 'checkdb',
      label: 'Check integrity',
      description: 'DBCC CHECKDB: check the logical and physical integrity of every object',
      hint: 'Runs DBCC CHECKDB, or DBCC CHECKTABLE for chosen tables. Checks the allocation, structure and logical consistency of every page, table, index and catalog entry, and reports any corruption. Read-only but I/O heavy, so schedule it outside busy hours. Run it regularly so corruption is caught while good backups still exist.',
      options: ['physicalOnly'],
      perTable: true
    },
    {
      value: 'statistics',
      label: 'Update statistics',
      description: 'Refresh the statistics the query optimizer relies on',
      hint: 'Runs sp_updatestats, or UPDATE STATISTICS for each table. Refreshes the histograms and density information the optimizer uses to estimate row counts. sp_updatestats samples and skips statistics with no changes; Full scan reads every row for exact statistics.',
      options: ['fullScan'],
      perTable: true
    },
    {
      value: 'rebuild',
      label: 'Rebuild indexes',
      description: 'Recreate indexes from scratch, removing all fragmentation',
      hint: "Runs ALTER INDEX ALL ... REBUILD on each table. Drops and recreates every index on the table, removing all fragmentation, compacting pages and refreshing the indexes' statistics with a full scan. Usually recommended over reorganizing above about 30% fragmentation.",
      options: ['online'],
      perTable: true,
      eachTable: true
    },
    {
      value: 'reorganize',
      label: 'Reorganize indexes',
      description: 'Defragment index leaf pages in place; always online and interruptible',
      hint: "Runs ALTER INDEX ALL ... REORGANIZE on each table. Reorders and compacts index leaf pages in place. Lighter than a rebuild: always online, and stopping it partway keeps the work already done. Suits light fragmentation (roughly 5-30%). It doesn't update statistics.",
      options: [],
      perTable: true,
      eachTable: true
    },
    {
      value: 'shrink',
      label: 'Shrink',
      description: 'Release unused space in the data and log files back to the operating system',
      hint: 'Runs DBCC SHRINKDATABASE. Moves pages toward the start of each data and log file and releases the free space at the end to the operating system. It heavily fragments indexes and the files usually grow again, so only use it after removing a lot of data for good.',
      options: [],
      perTable: false
    }
  ],
  babelfish: [],
  // Redis manages its own memory and persistence; there's nothing to vacuum or reindex
  redis: [],
  sqlite: [
    {
      value: 'vacuum',
      label: 'Vacuum',
      description: 'Rebuild the database file, reclaiming free pages and defragmenting it',
      hint: 'Runs VACUUM. Rebuilds the whole database into a new file, dropping free pages, defragmenting tables and indexes, and shrinking the file. Needs exclusive access and up to twice the database size in free disk space while it runs.',
      options: [],
      perTable: false
    },
    {
      value: 'analyze',
      label: 'Analyze',
      description: 'Gather statistics about tables and indexes for the query planner',
      hint: 'Runs ANALYZE. Gathers statistics about tables and indexes into the sqlite_stat tables so the query planner can choose better indexes. Run it after big data changes or after adding indexes.',
      options: [],
      perTable: true
    },
    {
      value: 'pragma-optimize',
      label: 'Optimize',
      description: 'PRAGMA optimize: let SQLite run the analysis it thinks is worthwhile',
      hint: 'Runs PRAGMA optimize. Lets SQLite decide which tables need fresh statistics and analyze only those. Cheap; SQLite suggests running it periodically and before closing long-lived connections.',
      options: [],
      perTable: false
    },
    {
      value: 'integrity',
      label: 'Check integrity',
      description: 'Look for corruption, out-of-order records and malformed indexes',
      hint: 'Runs PRAGMA integrity_check. Scans the whole database for corruption: malformed records, out-of-order rows, missing or extra index entries, constraint violations and free-list problems. Prints ok when nothing is wrong.',
      options: ['quick'],
      perTable: false
    },
    {
      value: 'reindex',
      label: 'Reindex',
      description: 'Delete and recreate indexes from scratch',
      hint: "Runs REINDEX. Deletes and recreates indexes from the table data. Mainly needed after a collation's definition changes, or to repair a corrupt index.",
      options: [],
      perTable: true
    },
    {
      value: 'checkpoint',
      label: 'Checkpoint',
      description: 'Copy the write-ahead log into the database and truncate it',
      hint: 'Runs PRAGMA wal_checkpoint(TRUNCATE). In WAL mode, copies all changes from the -wal file into the main database file and truncates the WAL to zero bytes. Useful before copying the database file or when the WAL has grown large. Does nothing in rollback-journal mode.',
      options: [],
      perTable: false
    }
  ],
  mongo: [
    {
      value: 'validate',
      label: 'Validate',
      description: 'Check collections and their indexes for correctness',
      hint: "Runs the validate command on each collection. Checks the collection's data and index structures and reports corrupt documents, index inconsistencies and record counts. It locks each collection while it runs, so avoid busy production collections.",
      options: ['full'],
      perTable: true,
      eachTable: true
    },
    {
      value: 'compact',
      label: 'Compact',
      description:
        'Defragment collection data and indexes to release space to the operating system',
      hint: "Runs the compact command on each collection. Rewrites and defragments the collection's data and indexes so WiredTiger can return freed space to the operating system, typically after deleting many documents. On a replica set it only compacts the member you're connected to.",
      options: [],
      perTable: true,
      eachTable: true
    }
  ]
}

/** Overrides of OPTION_INFO for tasks where an option means something else. */
const OPTION_OVERRIDES: Partial<Record<string, OptionText>> = {
  'mongo:full': {
    label: 'Full',
    description: 'Check every document thoroughly; slow and locking',
    hint: 'Adds full: true. Checks every document and index entry in depth instead of the default faster checks. Much slower, and takes an exclusive lock on each collection.'
  },
  'mysql:extended:repair': {
    label: 'Extended',
    description: 'Rebuild the index row by row instead of by sorting',
    hint: 'Adds EXTENDED: rebuilds the index row by row instead of by sorting. Very slow; use it only when a plain repair fails.'
  }
}

export function optionInfo(
  engine: Engine,
  task: MaintenanceTask,
  option: MaintenanceOption
): OptionText {
  return (
    OPTION_OVERRIDES[`${engine}:${option}:${task}`] ??
    OPTION_OVERRIDES[`${engine}:${option}`] ??
    OPTION_INFO[option]
  )
}

export function maintenanceTasks(engine: Engine): MaintenanceTaskInfo[] {
  return TASKS[engine]
}

export function taskInfo(engine: Engine, task: MaintenanceTask): MaintenanceTaskInfo | undefined {
  return TASKS[engine].find((t) => t.value === task)
}

export function newMaintenanceDraft(engine: Engine): MaintenanceDraft {
  return {
    task: TASKS[engine][0]?.value ?? 'analyze',
    scope: 'all',
    tables: [],
    options: { analyze: true }
  }
}

/** A task and tables to start the maintenance tab on, e.g. from the server tab's table health. */
export interface MaintenancePreset {
  task: MaintenanceTask
  tables: TableRef[]
  options?: Partial<Record<MaintenanceOption, boolean>>
  /** Changes each time the preset is applied, so re-opening the same tab applies it again */
  nonce: number
}

export function presetDraft(engine: Engine, preset: MaintenancePreset): MaintenanceDraft {
  const draft = newMaintenanceDraft(engine)
  return {
    ...draft,
    task: taskInfo(engine, preset.task) ? preset.task : draft.task,
    scope: preset.tables.length ? 'tables' : 'all',
    tables: preset.tables,
    options: preset.options ?? draft.options
  }
}

const DIALECTS: Partial<Record<Engine, Dialect>> = {
  postgres: 'postgres',
  mysql: 'mysql',
  mssql: 'tsql',
  sqlite: 'sqlite'
}

const nString = (s: string): string => `N'${s.replace(/'/g, "''")}'`

function pgSteps(
  database: string,
  draft: MaintenanceDraft,
  targets: TableRef[]
): MaintenanceStep[] {
  const o = draft.options
  const name = (t: TableRef): string => qualified('postgres', t)
  const parens = (list: string[]): string => (list.length ? ` (${list.join(', ')})` : '')
  const each = (build: (target: string) => string): MaintenanceStep[] =>
    draft.scope === 'all'
      ? [{ label: database, sql: build('') }]
      : targets.map((t) => ({ label: name(t), sql: build(` ${name(t)}`) }))
  switch (draft.task) {
    case 'vacuum': {
      const flags = [
        o.full && 'FULL',
        o.freeze && 'FREEZE',
        o.verbose && 'VERBOSE',
        o.analyze && 'ANALYZE'
      ].filter((f): f is string => !!f)
      return each((target) => `VACUUM${parens(flags)}${target}`)
    }
    case 'analyze':
      return each((target) => `ANALYZE${parens(o.verbose ? ['VERBOSE'] : [])}${target}`)
    case 'reindex': {
      const head = `REINDEX${parens(o.verbose ? ['VERBOSE'] : [])}`
      const how = o.concurrently ? ' CONCURRENTLY' : ''
      return draft.scope === 'all'
        ? [{ label: database, sql: `${head} DATABASE${how} ${quoteIdent('postgres', database)}` }]
        : targets.map((t) => ({ label: name(t), sql: `${head} TABLE${how} ${name(t)}` }))
    }
    default:
      return []
  }
}

function mysqlSteps(draft: MaintenanceDraft, targets: TableRef[]): MaintenanceStep[] {
  const o = draft.options
  const local = o.local ? ' NO_WRITE_TO_BINLOG' : ''
  const statement = (target: string): string | null => {
    switch (draft.task) {
      case 'optimize':
        return `OPTIMIZE${local} TABLE ${target}`
      case 'analyze':
        return `ANALYZE${local} TABLE ${target}`
      case 'check':
        return `CHECK TABLE ${target}${o.extended ? ' EXTENDED' : ''}`
      case 'repair':
        return `REPAIR${local} TABLE ${target}${o.extended ? ' EXTENDED' : ''}`
      default:
        return null
    }
  }
  return targets.flatMap((t) => {
    const target = qualified('mysql', t)
    const sql = statement(target)
    return sql ? [{ label: target, sql }] : []
  })
}

function mssqlSteps(
  database: string,
  draft: MaintenanceDraft,
  targets: TableRef[]
): MaintenanceStep[] {
  const o = draft.options
  const name = (t: TableRef): string => qualified('tsql', t)
  switch (draft.task) {
    case 'checkdb': {
      const flags = ['NO_INFOMSGS', 'ALL_ERRORMSGS', ...(o.physicalOnly ? ['PHYSICAL_ONLY'] : [])]
      const how = ` WITH ${flags.join(', ')}`
      return draft.scope === 'all'
        ? [{ label: database, sql: `DBCC CHECKDB (${nString(database)})${how}` }]
        : targets.map((t) => ({
            label: name(t),
            sql: `DBCC CHECKTABLE (${nString(name(t))})${how}`
          }))
    }
    case 'statistics':
      // sp_updatestats samples and skips unchanged statistics; a full scan needs each table
      return draft.scope === 'all' && !o.fullScan
        ? [{ label: database, sql: 'EXEC sp_updatestats' }]
        : targets.map((t) => ({
            label: name(t),
            sql: `UPDATE STATISTICS ${name(t)}${o.fullScan ? ' WITH FULLSCAN' : ''}`
          }))
    case 'rebuild':
      return targets.map((t) => ({
        label: name(t),
        sql: `ALTER INDEX ALL ON ${name(t)} REBUILD${o.online ? ' WITH (ONLINE = ON)' : ''}`
      }))
    case 'reorganize':
      return targets.map((t) => ({
        label: name(t),
        sql: `ALTER INDEX ALL ON ${name(t)} REORGANIZE`
      }))
    case 'shrink':
      return [{ label: database, sql: `DBCC SHRINKDATABASE (${nString(database)})` }]
    default:
      return []
  }
}

function sqliteSteps(draft: MaintenanceDraft, targets: TableRef[]): MaintenanceStep[] {
  const name = (t: TableRef): string => quoteIdent('sqlite', t.name)
  const each = (verb: string): MaintenanceStep[] =>
    draft.scope === 'all'
      ? [{ label: 'database', sql: verb }]
      : targets.map((t) => ({ label: name(t), sql: `${verb} ${name(t)}` }))
  switch (draft.task) {
    case 'vacuum':
      return [{ label: 'database', sql: 'VACUUM' }]
    case 'analyze':
      return each('ANALYZE')
    case 'reindex':
      return each('REINDEX')
    case 'pragma-optimize':
      return [{ label: 'database', sql: 'PRAGMA optimize' }]
    case 'integrity':
      return [
        {
          label: 'database',
          sql: draft.options.quick ? 'PRAGMA quick_check' : 'PRAGMA integrity_check'
        }
      ]
    case 'checkpoint':
      return [{ label: 'database', sql: 'PRAGMA wal_checkpoint(TRUNCATE)' }]
    default:
      return []
  }
}

function mongoSteps(draft: MaintenanceDraft, targets: TableRef[]): MaintenanceStep[] {
  switch (draft.task) {
    case 'validate':
      return targets.map((t) => ({
        label: t.name,
        command: draft.options.full ? { validate: t.name, full: true } : { validate: t.name }
      }))
    case 'compact':
      return targets.map((t) => ({ label: t.name, command: { compact: t.name } }))
    default:
      return []
  }
}

/**
 * The statements a maintenance run executes, in order. `allTables` lists every
 * table (or collection) in the database, for tasks that run once per table.
 */
export function maintenanceSteps(
  engine: Engine,
  database: string,
  draft: MaintenanceDraft,
  allTables: TableRef[]
): MaintenanceStep[] {
  const targets = draft.scope === 'tables' ? draft.tables : allTables
  switch (engine) {
    case 'postgres':
      return pgSteps(database, draft, targets)
    case 'mysql':
      return mysqlSteps(draft, targets)
    case 'mssql':
      return mssqlSteps(database, draft, targets)
    case 'sqlite':
      return sqliteSteps(draft, targets)
    case 'mongo':
      return mongoSteps(draft, targets)
    case 'babelfish':
    case 'redis':
      return []
  }
}

/** The steps as one script, for the preview and for opening in a query tab. */
export function maintenanceScript(engine: Engine, steps: MaintenanceStep[]): string {
  if (engine === 'mongo') {
    return steps
      .map((s) => ('command' in s ? `db.runCommand(${JSON.stringify(s.command)})` : ''))
      .join('\n')
  }
  const sep = DIALECTS[engine] === 'tsql' ? '\nGO\n' : ';\n'
  const body = steps.map((s) => ('sql' in s ? s.sql : '')).join(sep)
  return body && DIALECTS[engine] !== 'tsql' ? `${body};` : body
}

/** Why the draft can't run yet, or null. */
export function validateMaintenance(
  engine: Engine,
  draft: MaintenanceDraft,
  steps: MaintenanceStep[]
): string | null {
  const info = taskInfo(engine, draft.task)
  if (!info) return 'Choose a task'
  const noun = engine === 'mongo' ? 'collection' : 'table'
  if (draft.scope === 'tables' && info.perTable && !draft.tables.length) {
    return `Choose at least one ${noun}`
  }
  if (!steps.length) return `There are no ${noun}s to run this on`
  return null
}

/** Warnings worth reading before running the task. */
export function maintenanceWarnings(engine: Engine, draft: MaintenanceDraft): string[] {
  const o = draft.options
  const out: string[] = []
  if (engine === 'postgres' && draft.task === 'vacuum' && o.full) {
    out.push(
      'VACUUM FULL locks each table against reads and writes while it rewrites it, and needs free disk space for a full copy.'
    )
  }
  if (engine === 'postgres' && draft.task === 'reindex' && !o.concurrently) {
    out.push('REINDEX blocks writes to each table while its indexes rebuild.')
  }
  if (engine === 'mysql' && draft.task === 'optimize') {
    out.push(
      'InnoDB rebuilds each table to optimize it, which copies the table and can take a long time on large ones.'
    )
  }
  if (engine === 'mysql' && draft.task === 'repair') {
    out.push(
      'InnoDB tables don’t support REPAIR; they report that the storage engine doesn’t support it.'
    )
  }
  if (engine === 'mssql' && draft.task === 'rebuild' && !o.online) {
    out.push('An offline rebuild locks each table for the duration of its rebuild.')
  }
  if (engine === 'mssql' && draft.task === 'shrink') {
    out.push(
      'Shrinking fragments indexes badly and the files usually grow back. Prefer it only after deleting a large amount of data.'
    )
  }
  if (engine === 'sqlite' && draft.task === 'vacuum') {
    out.push('VACUUM needs up to twice the size of the database in free disk space while it runs.')
  }
  if (engine === 'mongo' && draft.task === 'compact') {
    out.push(
      'compact runs on the member you’re connected to only. Before MongoDB 4.4 it blocks all activity in the database.'
    )
  }
  if (engine === 'mongo' && draft.task === 'validate' && o.full) {
    out.push('A full validation takes an exclusive lock on each collection while it runs.')
  }
  return out
}

/**
 * A result set as log lines, one per row. MySQL's table maintenance results
 * print as "type: message", single-column results as just the value.
 */
export function resultLines(set: ResultSet): string[] {
  const cols = set.columns.map((c) => c.name)
  const lower = cols.map((c) => c.toLowerCase())
  const type = lower.indexOf('msg_type')
  const text = lower.indexOf('msg_text')
  if (type >= 0 && text >= 0) return set.rows.map((row) => `${row[type] ?? ''}: ${row[text] ?? ''}`)
  return set.rows.map((row) =>
    row.length === 1
      ? String(row[0] ?? 'NULL')
      : row.map((cell, i) => `${cols[i] ?? i}: ${cell ?? 'NULL'}`).join('  ·  ')
  )
}

/** Rows of a MySQL CHECK / REPAIR / OPTIMIZE result reporting an error. */
export function resultErrors(set: ResultSet): number {
  const type = set.columns.findIndex((c) => c.name.toLowerCase() === 'msg_type')
  if (type < 0) return 0
  return set.rows.filter((r) => String(r[type] ?? '').toLowerCase() === 'error').length
}

function num(value: unknown): number | null {
  if (typeof value === 'number') return value
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>
    const inner = v.$numberLong ?? v.$numberInt ?? v.$numberDouble
    if (inner !== undefined) return Number(inner)
  }
  return null
}

/** A MongoDB maintenance command's reply as log lines, and whether it reported a problem. */
export function mongoReplyLines(
  command: Record<string, unknown>,
  reply: unknown
): { lines: string[]; failed: boolean } {
  const r = (reply && typeof reply === 'object' ? reply : {}) as Record<string, unknown>
  if ('validate' in command) {
    const errors = Array.isArray(r.errors) ? r.errors.map(String) : []
    const warnings = Array.isArray(r.warnings) ? r.warnings.map(String) : []
    const valid = r.valid !== false && !errors.length
    const records = num(r.nrecords)
    const indexes = num(r.nIndexes)
    const facts = [
      records !== null && `${records.toLocaleString()} documents`,
      indexes !== null && `${indexes} indexes`
    ].filter(Boolean)
    return {
      lines: [
        `${valid ? 'valid' : 'INVALID'}${facts.length ? ` (${facts.join(', ')})` : ''}`,
        ...errors.map((e) => `error: ${e}`),
        ...warnings.map((w) => `warning: ${w}`)
      ],
      failed: !valid
    }
  }
  if ('compact' in command) {
    const freed = num(r.bytesFreed)
    return {
      lines: [freed !== null ? `compacted, ${freed.toLocaleString()} bytes freed` : 'compacted'],
      failed: false
    }
  }
  return { lines: [JSON.stringify(reply)], failed: false }
}
