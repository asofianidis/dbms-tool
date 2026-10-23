import type {
  BackupContent,
  BackupInspection,
  BackupJob,
  BackupTool,
  Cell,
  Engine,
  ObjectName,
  PgFormat,
  ResultSet
} from './api'
import { literal, quoteIdent } from './sql'

/* ---------- Tool-based backups (PostgreSQL, MySQL, MongoDB) ---------- */

/** Whole database, chosen schemas (PostgreSQL), or chosen tables / collections. */
export type BackupScope = 'all' | 'schemas' | 'tables'

export interface BackupDraft {
  database: string
  scope: BackupScope
  schemas: string[]
  /** Tables (PostgreSQL, MySQL) or collections (MongoDB); schema is null outside PostgreSQL */
  tables: ObjectName[]
  content: BackupContent
  /** File or folder the backup is written to */
  path: string
  pgFormat: PgFormat
  noOwner: boolean
  noPrivileges: boolean
  /** Plain format: DROP … IF EXISTS before each CREATE */
  clean: boolean
  /** Plain format: CREATE DATABASE and connect to it */
  create: boolean
  inserts: boolean
  /** 0–9, custom and directory formats */
  compression: number
  /** Parallel workers, directory format */
  jobs: number
  createDatabase: boolean
  routines: boolean
  triggers: boolean
  events: boolean
  dropTables: boolean
  singleTransaction: boolean
  hexBlob: boolean
  extendedInsert: boolean
  /** MongoDB: one archive file rather than a folder of BSON files */
  archive: boolean
  gzip: boolean
}

export function newBackupDraft(database: string): BackupDraft {
  return {
    database,
    scope: 'all',
    schemas: [],
    tables: [],
    content: 'all',
    path: '',
    pgFormat: 'custom',
    noOwner: false,
    noPrivileges: false,
    clean: true,
    create: false,
    inserts: false,
    compression: 6,
    jobs: 4,
    createDatabase: false,
    routines: true,
    triggers: true,
    events: false,
    dropTables: true,
    singleTransaction: true,
    hexBlob: true,
    extendedInsert: true,
    archive: true,
    gzip: true
  }
}

/** Whether the backup is written to a folder rather than a file. */
export function backupIsFolder(engine: Engine, draft: BackupDraft): boolean {
  return engine === 'postgres'
    ? draft.pgFormat === 'directory'
    : engine === 'mongo' && !draft.archive
}

export function backupExtension(engine: Engine, draft: BackupDraft): string {
  if (backupIsFolder(engine, draft)) return ''
  if (engine === 'postgres') {
    return draft.pgFormat === 'plain' ? '.sql' : draft.pgFormat === 'tar' ? '.tar' : '.dump'
  }
  if (engine === 'mongo') return draft.gzip ? '.archive.gz' : '.archive'
  return '.sql'
}

const pad = (n: number): string => String(n).padStart(2, '0')

export function timestamp(now: Date): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`
}

/** e.g. `shop_2026-10-22_1430.dump`; characters file systems reject become `_`. */
export function defaultBackupName(engine: Engine, draft: BackupDraft, now = new Date()): string {
  const base = draft.database.replace(/[\\/:*?"<>|\s]+/g, '_') || 'backup'
  return `${base}_${timestamp(now)}${backupExtension(engine, draft)}`
}

/** Swaps the extension of `path` when the format changes; leaves other names alone. */
export function withExtension(path: string, from: string, to: string): string {
  if (!path || from === to) return path
  if (from && path.endsWith(from)) return path.slice(0, -from.length) + to
  return from ? path : path + to
}

export function validateBackup(engine: Engine, draft: BackupDraft): string | null {
  if (!draft.database) return 'Choose a database to back up'
  if (draft.scope === 'schemas' && !draft.schemas.length) return 'Choose at least one schema'
  if (draft.scope === 'tables' && !draft.tables.length) {
    return engine === 'mongo' ? 'Choose at least one collection' : 'Choose at least one table'
  }
  if (!draft.path.trim()) return 'Choose where to save the backup'
  return null
}

/** The job the backend runs. `collections` lists every collection, to exclude the unchosen ones. */
export function backupJob(
  engine: Engine,
  draft: BackupDraft,
  collections: string[] = []
): BackupJob {
  const path = draft.path.trim()
  const schemas = draft.scope === 'schemas' ? draft.schemas : []
  const tables = draft.scope === 'tables' ? draft.tables : []
  switch (engine) {
    case 'postgres':
      return {
        tool: 'pg_dump',
        database: draft.database,
        file: path,
        format: draft.pgFormat,
        content: draft.content,
        schemas,
        tables,
        noOwner: draft.noOwner,
        noPrivileges: draft.noPrivileges,
        clean: draft.clean,
        create: draft.create,
        inserts: draft.inserts,
        compression: draft.compression,
        jobs: draft.jobs
      }
    case 'mysql':
      return {
        tool: 'mysqldump',
        database: draft.database,
        file: path,
        content: draft.content,
        tables: tables.map((t) => t.name),
        createDatabase: draft.createDatabase,
        routines: draft.routines,
        triggers: draft.triggers,
        events: draft.events,
        dropTables: draft.dropTables,
        singleTransaction: draft.singleTransaction,
        hexBlob: draft.hexBlob,
        extendedInsert: draft.extendedInsert
      }
    case 'mongo': {
      const chosen = new Set(tables.map((t) => t.name))
      return {
        tool: 'mongodump',
        database: draft.database,
        path,
        archive: draft.archive,
        gzip: draft.gzip,
        excludeCollections:
          draft.scope === 'tables' ? collections.filter((c) => !chosen.has(c)) : []
      }
    }
    default:
      throw new Error(`${engine} backups don't use client tools`)
  }
}

export type RestoreTarget = 'existing' | 'new'

export interface RestoreDraft {
  path: string
  target: RestoreTarget
  database: string
  scope: BackupScope
  schemas: string[]
  /** Tables (PostgreSQL) or collections with their database in `schema` (MongoDB) */
  tables: ObjectName[]
  content: BackupContent
  clean: boolean
  noOwner: boolean
  noPrivileges: boolean
  singleTransaction: boolean
  stopOnError: boolean
  jobs: number
  /** MongoDB: drop each collection before restoring it */
  drop: boolean
  noIndexRestore: boolean
}

export function newRestoreDraft(database: string): RestoreDraft {
  return {
    path: '',
    target: database ? 'existing' : 'new',
    database,
    scope: 'all',
    schemas: [],
    tables: [],
    content: 'all',
    clean: false,
    noOwner: false,
    noPrivileges: false,
    singleTransaction: false,
    stopOnError: true,
    jobs: 1,
    drop: false,
    noIndexRestore: false
  }
}

/** Distinct databases a MongoDB backup holds. */
export function backupDatabases(inspection: BackupInspection): string[] {
  return [...new Set(inspection.entries.map((e) => e.schema).filter((s): s is string => !!s))]
}

/** A MongoDB backup of several databases restores them under their own names. */
export function restoresAsNamed(engine: Engine, inspection: BackupInspection | null): boolean {
  return engine === 'mongo' && !!inspection && backupDatabases(inspection).length > 1
}

/** Whether restore-time selection is possible: archives list their contents, scripts don't. */
export function canSelectObjects(engine: Engine, inspection: BackupInspection | null): boolean {
  if (!inspection) return false
  if (engine === 'postgres') return inspection.format !== 'plain'
  return engine === 'mongo' && inspection.entries.length > 0
}

export function validateRestore(
  engine: Engine,
  draft: RestoreDraft,
  inspection: BackupInspection | null,
  existing: string[]
): string | null {
  if (!inspection) return 'Choose a backup to restore'
  if (!restoresAsNamed(engine, inspection)) {
    const name = draft.database.trim()
    if (!name) return 'Choose a database to restore into'
    if (draft.target === 'new' && existing.some((d) => d.toLowerCase() === name.toLowerCase())) {
      return `${name} already exists; choose it as an existing database or pick another name`
    }
  }
  if (draft.scope === 'schemas' && !draft.schemas.length) return 'Choose at least one schema'
  if (draft.scope === 'tables' && !draft.tables.length) {
    return engine === 'mongo' ? 'Choose at least one collection' : 'Choose at least one table'
  }
  return null
}

export function restoreJob(
  engine: Engine,
  draft: RestoreDraft,
  inspection: BackupInspection
): BackupJob {
  const database = draft.database.trim()
  const scoped = canSelectObjects(engine, inspection)
  const schemas = scoped && draft.scope === 'schemas' ? draft.schemas : []
  const tables = scoped && draft.scope === 'tables' ? draft.tables : []
  switch (engine) {
    case 'postgres':
      if (inspection.format === 'plain') {
        return {
          tool: 'psql',
          database,
          file: inspection.path,
          singleTransaction: draft.singleTransaction && !inspection.createsDatabase,
          stopOnError: draft.stopOnError
        }
      }
      return {
        tool: 'pg_restore',
        database,
        file: inspection.path,
        content: draft.content,
        schemas,
        tables,
        clean: draft.clean,
        noOwner: draft.noOwner,
        noPrivileges: draft.noPrivileges,
        singleTransaction: draft.singleTransaction,
        exitOnError: draft.stopOnError,
        jobs: draft.singleTransaction ? 1 : draft.jobs
      }
    case 'mysql':
      return { tool: 'mysql', database, file: inspection.path, force: !draft.stopOnError }
    case 'mongo': {
      const asNamed = restoresAsNamed(engine, inspection)
      return {
        tool: 'mongorestore',
        path: inspection.path,
        archive: inspection.format === 'archive',
        gzip: inspection.gzip,
        namespaces: tables.map((t) => `${t.schema}.${t.name}`),
        fromDatabase: asNamed ? null : (inspection.database ?? null),
        toDatabase: asNamed ? null : database,
        drop: draft.drop,
        stopOnError: draft.stopOnError,
        noIndexRestore: draft.noIndexRestore
      }
    }
    default:
      throw new Error(`${engine} restores don't use client tools`)
  }
}

/** Statement creating the target of a restore into a new database; MongoDB creates it on first write. */
export function createDatabaseSql(engine: Engine, name: string): string | null {
  if (engine === 'postgres') return `CREATE DATABASE ${quoteIdent('postgres', name)}`
  if (engine === 'mysql') return `CREATE DATABASE ${quoteIdent('mysql', name)}`
  return null
}

/** Warns when pg_dump is older than the server, which it refuses to dump. */
export function toolVersionProblem(tool: BackupTool, serverVersion: string): string | null {
  if (!tool.path || !tool.kind.startsWith('pg') || !tool.version) return null
  const major = (text: string): number | null => {
    const match = text.match(/(\d+)(?:\.(\d+))?/)
    return match ? Number(match[1]) : null
  }
  const toolMajor = major(tool.version.replace(/^\D*\)/, ''))
  const serverMajor = major(serverVersion.replace(/^\D+/, ''))
  if (toolMajor === null || serverMajor === null || toolMajor >= serverMajor) return null
  return `${tool.kind} ${toolMajor} is older than the server (PostgreSQL ${serverMajor}) and will refuse to run. Install PostgreSQL ${serverMajor} client tools or newer.`
}

/* ---------- SQL Server (server-side BACKUP / RESTORE) ---------- */

const str = (value: string): string => literal('tsql', value, 'nvarchar')

export type MssqlBackupType = 'full' | 'differential' | 'log'

export interface MssqlBackupDraft {
  database: string
  type: MssqlBackupType
  copyOnly: boolean
  compression: 'default' | 'on' | 'off'
  checksum: boolean
  verify: boolean
  /** Replace backup sets already in the file rather than appending */
  overwrite: boolean
  name: string
  /** Path on the database server */
  path: string
}

export function newMssqlBackupDraft(database: string): MssqlBackupDraft {
  return {
    database,
    type: 'full',
    copyOnly: false,
    compression: 'default',
    checksum: true,
    verify: true,
    overwrite: true,
    name: '',
    path: ''
  }
}

/** Server-side folders and capabilities the wizards need. */
export interface MssqlServer {
  backupDir: string
  dataDir: string
  logDir: string
  /** SERVERPROPERTY('EngineEdition'): 4 Express, 5 Azure SQL Database, 8 Managed Instance */
  edition: number
  /** SIMPLE | FULL | BULK_LOGGED for the chosen database */
  recoveryModel: string | null
}

export function mssqlServerSql(database: string): string {
  return `SELECT CAST(SERVERPROPERTY('InstanceDefaultBackupPath') AS nvarchar(4000)),
  CAST(SERVERPROPERTY('InstanceDefaultDataPath') AS nvarchar(4000)),
  CAST(SERVERPROPERTY('InstanceDefaultLogPath') AS nvarchar(4000)),
  CAST(SERVERPROPERTY('EngineEdition') AS int),
  (SELECT recovery_model_desc FROM sys.databases WHERE name = ${str(database)})`
}

const text = (cell: Cell | undefined): string => (typeof cell === 'string' ? cell : '')

export function parseMssqlServer(row: Cell[] | undefined): MssqlServer {
  return {
    backupDir: text(row?.[0]),
    dataDir: text(row?.[1]),
    logDir: text(row?.[2]) || text(row?.[1]),
    edition: Number(text(row?.[3])) || 0,
    recoveryModel: text(row?.[4]) || null
  }
}

/** Joins a server folder and file name with the server's own separator. */
export function joinServerPath(dir: string, file: string): string {
  if (!dir) return file
  const sep = dir.includes('\\') || /^[a-z]:/i.test(dir) ? '\\' : '/'
  return dir.endsWith('\\') || dir.endsWith('/') ? dir + file : dir + sep + file
}

export function serverFileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

export function defaultMssqlBackupPath(
  server: MssqlServer,
  draft: MssqlBackupDraft,
  now = new Date()
): string {
  const ext = draft.type === 'log' ? '.trn' : '.bak'
  const kind = draft.type === 'full' ? '' : `_${draft.type === 'log' ? 'log' : 'diff'}`
  const base = draft.database.replace(/[\\/:*?"<>|\s]+/g, '_')
  return joinServerPath(server.backupDir, `${base}${kind}_${timestamp(now)}${ext}`)
}

export function validateMssqlBackup(
  draft: MssqlBackupDraft,
  server: MssqlServer | null
): string | null {
  if (!draft.database) return 'Choose a database to back up'
  if (draft.type === 'log' && server?.recoveryModel === 'SIMPLE') {
    return 'Log backups need the FULL or BULK_LOGGED recovery model'
  }
  if (!draft.path.trim()) return 'Enter a path on the server'
  return null
}

export function mssqlBackupScript(draft: MssqlBackupDraft): string {
  const db = quoteIdent('tsql', draft.database)
  const path = str(draft.path.trim())
  const options = [
    draft.type === 'differential' && 'DIFFERENTIAL',
    draft.copyOnly && 'COPY_ONLY',
    draft.overwrite ? 'INIT' : 'NOINIT',
    `NAME = ${str(draft.name.trim() || `${draft.database} ${draft.type} backup`)}`,
    draft.compression === 'on' && 'COMPRESSION',
    draft.compression === 'off' && 'NO_COMPRESSION',
    draft.checksum && 'CHECKSUM',
    'STATS = 5'
  ].filter(Boolean)
  const lines = [
    `BACKUP ${draft.type === 'log' ? 'LOG' : 'DATABASE'} ${db}`,
    `TO DISK = ${path}`,
    `WITH ${options.join(', ')};`
  ]
  if (draft.verify) {
    // An appended set lands after the others, so verify the newest one in the file
    lines.push(
      '',
      `DECLARE @position int = (SELECT MAX(s.position) FROM msdb.dbo.backupset s
  JOIN msdb.dbo.backupmediafamily m ON m.media_set_id = s.media_set_id
  WHERE m.physical_device_name = ${path});`,
      `RESTORE VERIFYONLY FROM DISK = ${path} WITH FILE = @position${draft.checksum ? ', CHECKSUM' : ''};`
    )
  }
  return lines.join('\n')
}

export const MSSQL_RECENT_BACKUPS_SQL = `SELECT TOP 50 s.database_name, s.type, CONVERT(nvarchar(30), s.backup_finish_date, 120),
  s.backup_size, m.physical_device_name, s.position, s.is_copy_only
FROM msdb.dbo.backupset s
JOIN msdb.dbo.backupmediafamily m ON m.media_set_id = s.media_set_id
WHERE m.device_type = 2
ORDER BY s.backup_finish_date DESC`

export interface MssqlRecentBackup {
  database: string
  type: string
  finished: string
  size: number | null
  path: string
  position: number
}

const MSDB_TYPES: Record<string, string> = { D: 'Full', I: 'Differential', L: 'Log' }

export function parseRecentBackups(rows: Cell[][]): MssqlRecentBackup[] {
  return rows.map((r) => ({
    database: text(r[0]),
    type: MSDB_TYPES[text(r[1])] ?? text(r[1]),
    finished: text(r[2]),
    size: r[3] === null ? null : Number(r[3]),
    path: text(r[4]),
    position: Number(text(r[5])) || 1
  }))
}

export function headerOnlySql(path: string): string {
  return `RESTORE HEADERONLY FROM DISK = ${str(path.trim())}`
}

export function fileListSql(path: string, position: number): string {
  return `RESTORE FILELISTONLY FROM DISK = ${str(path.trim())} WITH FILE = ${Math.max(1, Math.floor(position))}`
}

export interface MssqlBackupSet {
  position: number
  /** Full | Differential | Log | … */
  type: string
  database: string
  name: string
  finished: string
  size: number | null
}

const HEADER_TYPES: Record<string, string> = {
  '1': 'Full',
  '2': 'Log',
  '4': 'File',
  '5': 'Differential',
  '6': 'Differential file',
  '7': 'Partial',
  '8': 'Differential partial'
}

/** Rows of a result set keyed by column name; HEADERONLY's columns vary by version. */
function records(set: ResultSet | undefined): Record<string, Cell>[] {
  if (!set) return []
  return set.rows.map((row) =>
    Object.fromEntries(set.columns.map((c, i) => [c.name.toLowerCase(), row[i]]))
  )
}

export function parseHeaderOnly(set: ResultSet | undefined): MssqlBackupSet[] {
  return records(set).map((r) => ({
    position: Number(text(r.position)) || 1,
    type: HEADER_TYPES[text(r.backuptype)] ?? text(r.backuptype),
    database: text(r.databasename),
    name: text(r.backupname),
    finished: text(r.backupfinishdate),
    size: r.backupsize === null || r.backupsize === undefined ? null : Number(r.backupsize)
  }))
}

export interface MssqlFile {
  logical: string
  physical: string
  /** D data, L log, S filestream, F full-text */
  type: string
}

export function parseFileList(set: ResultSet | undefined): MssqlFile[] {
  return records(set).map((r) => ({
    logical: text(r.logicalname),
    physical: text(r.physicalname),
    type: text(r.type)
  }))
}

/**
 * Where each file goes when restoring `source` as `target`: the server's default
 * data or log folder, with the database name in the file name swapped, so a
 * copy never collides with the original's files.
 */
export function defaultMoves(
  files: MssqlFile[],
  source: string,
  target: string,
  server: MssqlServer
): MssqlFile[] {
  return files.map((f) => {
    let name = serverFileName(f.physical)
    if (target && source && target !== source) {
      name = name.toLowerCase().includes(source.toLowerCase())
        ? name.replace(new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), target)
        : `${target}_${name}`
    }
    const dir = f.type === 'L' ? server.logDir : server.dataDir
    const original = f.physical.slice(0, f.physical.length - serverFileName(f.physical).length)
    return { ...f, physical: dir ? joinServerPath(dir, name) : original + name }
  })
}

export interface MssqlRestoreDraft {
  path: string
  position: number
  database: string
  moves: MssqlFile[]
  /** WITH REPLACE: overwrite an existing database */
  replace: boolean
  /** Switch the database to single-user first, disconnecting everyone else */
  closeConnections: boolean
  /** RECOVERY (usable) rather than NORECOVERY (ready for more log backups) */
  recovery: boolean
}

export function newMssqlRestoreDraft(database: string): MssqlRestoreDraft {
  return {
    path: '',
    position: 1,
    database,
    moves: [],
    replace: false,
    closeConnections: true,
    recovery: true
  }
}

export function validateMssqlRestore(
  draft: MssqlRestoreDraft,
  sets: MssqlBackupSet[]
): string | null {
  if (!draft.path.trim()) return 'Enter the path of a backup on the server'
  if (!sets.length) return 'Read the backup to choose what to restore'
  if (!draft.database.trim()) return 'Enter a database to restore into'
  if (draft.moves.some((m) => !m.physical.trim())) return 'Every file needs a path on the server'
  return null
}

export function mssqlRestoreScript(draft: MssqlRestoreDraft): string {
  const name = draft.database.trim()
  const db = quoteIdent('tsql', name)
  const exists = `IF DB_ID(${str(name)}) IS NOT NULL`
  const options = [
    `FILE = ${draft.position}`,
    ...draft.moves.map((m) => `MOVE ${str(m.logical)} TO ${str(m.physical.trim())}`),
    draft.replace && 'REPLACE',
    draft.recovery ? 'RECOVERY' : 'NORECOVERY',
    'STATS = 5'
  ].filter(Boolean)
  const lines: string[] = []
  if (draft.closeConnections) {
    lines.push(`${exists} ALTER DATABASE ${db} SET SINGLE_USER WITH ROLLBACK IMMEDIATE;`, '')
  }
  lines.push(
    `RESTORE DATABASE ${db}`,
    `FROM DISK = ${str(draft.path.trim())}`,
    `WITH ${options.join(',\n  ')};`
  )
  // Runs even when the restore fails, so the database isn't left single-user
  if (draft.closeConnections) {
    lines.push(
      '',
      `${exists} AND DATABASEPROPERTYEX(${str(name)}, 'Status') = 'ONLINE' ALTER DATABASE ${db} SET MULTI_USER;`
    )
  }
  return lines.join('\n')
}

/** Percent done of a BACKUP/RESTORE running on session `spid`, from sys.dm_exec_requests. */
export function progressSql(spid: number): string {
  return `SELECT percent_complete FROM sys.dm_exec_requests WHERE session_id = ${Math.floor(spid)}`
}
