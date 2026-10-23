import { invoke } from '@tauri-apps/api/core'

export type Engine = 'postgres' | 'mysql' | 'mssql' | 'babelfish' | 'mongo' | 'sqlite'
export type SslMode = 'disable' | 'prefer' | 'require'
export type AuthMode = 'password' | 'windows' | 'cloud'

export interface ConnectionConfig {
  id: string
  name: string
  engine: Engine
  host: string
  port: number
  user: string
  database: string
  auth: AuthMode
  ssl: SslMode
  trustServerCertificate: boolean
  uri: string
  authSource: string
  savePassword: boolean
  readOnly: boolean
  color: string
  group: string
  lastUsed?: number | null
  /** The cloud resource this connection was found in or provisioned as */
  cloud?: CloudRef | null
}

export type CloudProvider = 'aws' | 'gcp' | 'azure' | 'railway' | 'render' | 'fly' | 'cloudflare'

/** Where a database lives in a cloud account, enough to look it up again. */
export interface CloudRef {
  provider: CloudProvider
  /** AWS profile, GCP project or Azure subscription; empty for the CLI default */
  context: string
  region: string
  /** Instance / cluster / server name */
  resource: string
  /** aws: instance | cluster; azure: postgres | mysql | sql */
  kind: string
  resourceGroup?: string
  /** A Google account gcloud holds, or a saved token's ID; absent for the CLI's own sign-in */
  account?: string
}

export interface CloudTool {
  provider: CloudProvider
  /** Resolved executable, null when the CLI isn't installed */
  path: string | null
}

export type BackupToolKind =
  'pg_dump' | 'pg_restore' | 'psql' | 'mysqldump' | 'mysql' | 'mongodump' | 'mongorestore'

export interface BackupTool {
  kind: BackupToolKind
  /** Resolved executable, null when it isn't installed */
  path: string | null
  /** First line of `--version` */
  version: string | null
}

export interface ObjectName {
  schema: string | null
  name: string
}

export type BackupContent = 'all' | 'schema' | 'data'
export type PgFormat = 'custom' | 'plain' | 'directory' | 'tar'

/** A backup or restore run by the engine's client tool (see backup.rs). */
export type BackupJob =
  | {
      tool: 'pg_dump'
      database: string
      file: string
      format: PgFormat
      content: BackupContent
      schemas: string[]
      tables: ObjectName[]
      noOwner: boolean
      noPrivileges: boolean
      clean: boolean
      create: boolean
      inserts: boolean
      compression: number | null
      jobs: number | null
    }
  | {
      tool: 'pg_restore'
      database: string
      file: string
      content: BackupContent
      schemas: string[]
      tables: ObjectName[]
      clean: boolean
      noOwner: boolean
      noPrivileges: boolean
      singleTransaction: boolean
      exitOnError: boolean
      jobs: number | null
    }
  | {
      tool: 'psql'
      database: string
      file: string
      singleTransaction: boolean
      stopOnError: boolean
    }
  | {
      tool: 'mysqldump'
      database: string
      file: string
      content: BackupContent
      tables: string[]
      createDatabase: boolean
      routines: boolean
      triggers: boolean
      events: boolean
      dropTables: boolean
      singleTransaction: boolean
      hexBlob: boolean
      extendedInsert: boolean
    }
  | { tool: 'mysql'; database: string; file: string; force: boolean }
  | {
      tool: 'mongodump'
      database: string
      path: string
      archive: boolean
      gzip: boolean
      excludeCollections: string[]
    }
  | {
      tool: 'mongorestore'
      path: string
      archive: boolean
      gzip: boolean
      namespaces: string[]
      fromDatabase: string | null
      toDatabase: string | null
      drop: boolean
      stopOnError: boolean
      noIndexRestore: boolean
    }

export interface BackupEntry {
  /** table | view | materialized_view | sequence | function | schema | collection | … */
  kind: string
  /** Schema (PostgreSQL) or database (MongoDB) */
  schema: string | null
  name: string
}

export interface BackupInspection {
  /** custom | tar | directory | plain (PostgreSQL), sql (MySQL), archive | dump (MongoDB) */
  format: string
  /** Path to restore from; a MongoDB database folder resolves to its dump folder */
  path: string
  size: number
  gzip: boolean
  database: string | null
  sourceVersion: string | null
  toolVersion: string | null
  /** The backup creates or switches to its own database, whatever the target */
  createsDatabase: boolean
  entries: BackupEntry[]
}

export interface BackupOutcome {
  cancelled: boolean
  elapsedMs: number
  size: number | null
  /** Error lines in the output of a run that still exited cleanly */
  errors: number
}

export interface BackupProgress {
  job: string
  lines: string[]
  /** Bytes of the backup fed to a restore so far */
  bytes: number | null
  total: number | null
}

export interface ServerInfo {
  product: string
  version: string
  currentDatabase: string
  user: string
  babelfishVersion: string | null
}

export interface DatabaseInfo {
  name: string
  isSystem: boolean
  sizeBytes: number | null
}

export interface SchemaInfo {
  name: string
  isSystem: boolean
}

export type ObjectKind =
  | 'table'
  | 'view'
  | 'materialized_view'
  | 'foreign_table'
  | 'sequence'
  | 'function'
  | 'procedure'
  | 'synonym'
  | 'collection'
  | 'timeseries'

export interface DbObject {
  schema: string | null
  name: string
  kind: ObjectKind
  detail: string | null
  comment: string | null
  rowEstimate: number | null
}

export interface ColumnInfo {
  name: string
  dataType: string
  nullable: boolean
  default: string | null
  isPrimaryKey: boolean
  isGenerated: boolean
  /** Identity / auto_increment only (not serial defaults or computed columns) */
  isIdentity: boolean
  comment: string | null
  /** MySQL column attributes such as `on update CURRENT_TIMESTAMP` */
  extra: string | null
}

export interface IndexInfo {
  name: string
  columns: string[]
  unique: boolean
  primary: boolean
  method: string | null
  definition: string | null
}

export interface ForeignKeyInfo {
  name: string
  columns: string[]
  refSchema: string | null
  refTable: string
  refColumns: string[]
  onUpdate: string | null
  onDelete: string | null
}

export interface TriggerInfo {
  name: string
  /** BEFORE | AFTER | INSTEAD OF */
  timing: string
  /** INSERT | UPDATE | DELETE | TRUNCATE */
  events: string[]
  /** FOR EACH ROW, as opposed to once per statement */
  rowLevel: boolean
  enabled: boolean
  definition: string | null
}

export interface TableInfo {
  columns: ColumnInfo[]
  primaryKey: string[]
  indexes: IndexInfo[]
  foreignKeys: ForeignKeyInfo[]
  triggers: TriggerInfo[]
}

export interface RoutineParam {
  name: string
  dataType: string
  /** IN | OUT | INOUT | VARIADIC | OUTPUT (T-SQL) */
  mode: string
}

export interface RoutineInfo {
  params: RoutineParam[]
  /** Return type for functions; `TABLE` for table-valued functions */
  returns: string | null
  language: string | null
}

export interface CompletionTable {
  schema: string | null
  name: string
  columns: string[]
}

export interface ColumnMeta {
  name: string
  typeName: string
}

export type Cell = string | boolean | null

export interface ResultSet {
  columns: ColumnMeta[]
  rows: Cell[][]
  rowCount: number
  truncated: boolean
}

export interface Message {
  level: 'info' | 'notice' | 'warning' | 'error' | 'rows'
  text: string
  atMs: number
}

export interface ErrorDetail {
  message: string
  position: number | null
  line: number | null
}

export interface ExecOutput {
  results: ResultSet[]
  messages: Message[]
  error: ErrorDetail | null
  elapsedMs: number
  cancelled: boolean
  database: string | null
}

export interface ExecOptions {
  maxRows?: number
}

/** Extended JSON value as produced by the backend. */
export type Ejson = unknown

export type MongoRequest =
  | {
      op: 'find'
      database: string
      collection: string
      filter?: Ejson
      projection?: Ejson
      sort?: Ejson
      skip?: number
      limit?: number
      count?: boolean
    }
  | { op: 'aggregate'; database: string; collection: string; pipeline: Ejson[] }
  | { op: 'count'; database: string; collection: string; filter?: Ejson }
  | { op: 'distinct'; database: string; collection: string; field: string; filter?: Ejson }
  | { op: 'insertOne'; database: string; collection: string; document: Ejson }
  | { op: 'insertMany'; database: string; collection: string; documents: Ejson[] }
  | {
      op: 'updateOne' | 'updateMany'
      database: string
      collection: string
      filter: Ejson
      update: Ejson
      upsert?: boolean
    }
  | {
      op: 'replaceOne'
      database: string
      collection: string
      filter: Ejson
      replacement: Ejson
      upsert?: boolean
    }
  | { op: 'deleteOne' | 'deleteMany'; database: string; collection: string; filter: Ejson }
  | { op: 'listIndexes'; database: string; collection: string }
  | { op: 'createIndex'; database: string; collection: string; keys: Ejson; options?: Ejson }
  | { op: 'dropIndex'; database: string; collection: string; name: string }
  | { op: 'createCollection' | 'dropCollection'; database: string; collection: string }
  | { op: 'dropDatabase'; database: string }
  | { op: 'runCommand'; database: string; command: Ejson }

export interface MongoOutput {
  kind: 'documents' | 'value'
  documents: Record<string, Ejson>[]
  value: Ejson | null
  total: number | null
  truncated: boolean
  elapsedMs: number
  cancelled: boolean
}

export interface AppError {
  code:
    'error' | 'password_required' | 'not_connected' | 'unknown_connection' | 'unsupported' | 'io'
  message: string
}

export function isAppError(e: unknown, code?: AppError['code']): e is AppError {
  return (
    !!e &&
    typeof e === 'object' &&
    'code' in e &&
    'message' in e &&
    (code === undefined || (e as AppError).code === code)
  )
}

export const api = {
  connectionsList: () => invoke<ConnectionConfig[]>('connections_list'),
  connectionSave: (config: ConnectionConfig, password?: string | null) =>
    invoke<ConnectionConfig>('connection_save', { config, password: password ?? null }),
  connectionDelete: (id: string) => invoke<void>('connection_delete', { id }),
  connectionTest: (config: ConnectionConfig, password?: string | null) =>
    invoke<ServerInfo>('connection_test', { config, password: password ?? null }),
  connectionOpen: (id: string, password?: string | null, remember?: boolean) =>
    invoke<ServerInfo>('connection_open', { id, password: password ?? null, remember }),
  connectionClose: (id: string) => invoke<void>('connection_close', { id }),

  databases: (id: string) => invoke<DatabaseInfo[]>('db_databases', { id }),
  schemas: (id: string, database: string) => invoke<SchemaInfo[]>('db_schemas', { id, database }),
  objects: (id: string, database: string, schema?: string | null) =>
    invoke<DbObject[]>('db_objects', { id, database, schema: schema ?? null }),
  table: (id: string, database: string, schema: string | null, name: string) =>
    invoke<TableInfo>('db_table', { id, database, schema, name }),
  definition: (
    id: string,
    database: string,
    schema: string | null,
    name: string,
    kind: string,
    detail?: string | null
  ) =>
    invoke<string | null>('db_definition', {
      id,
      database,
      schema,
      name,
      kind,
      detail: detail ?? null
    }),
  routine: (
    id: string,
    database: string,
    schema: string | null,
    name: string,
    kind: string,
    detail?: string | null
  ) =>
    invoke<RoutineInfo>('db_routine', { id, database, schema, name, kind, detail: detail ?? null }),
  completion: (id: string, database: string) =>
    invoke<CompletionTable[]>('db_completion', { id, database }),

  execute: (id: string, session: string, database: string, sql: string, options?: ExecOptions) =>
    invoke<ExecOutput>('query_execute', { id, session, database, sql, options }),
  cancel: (id: string, session: string) => invoke<void>('query_cancel', { id, session }),
  closeSession: (id: string, session: string) => invoke<void>('session_close', { id, session }),

  mongo: (id: string, session: string, request: MongoRequest, options?: ExecOptions) =>
    invoke<MongoOutput>('mongo_execute', { id, session, request, options }),

  writeText: (path: string, contents: string) =>
    invoke<void>('file_write_text', { path, contents }),
  writeBytes: (path: string, contents: Uint8Array) =>
    invoke<void>('file_write_bytes', contents, {
      headers: { 'x-path': encodeURIComponent(path) }
    }),
  readText: (path: string) => invoke<string>('file_read_text', { path }),

  cloudTools: () => invoke<CloudTool[]>('cloud_tools'),
  /** Runs a cloud CLI and returns stdout; `{secret}` in `args` becomes a temp file holding `secret` */
  cloudCli: (
    provider: CloudProvider,
    args: string[],
    options: { secret?: string; timeoutSecs?: number; workdir?: string; account?: string } = {}
  ) =>
    invoke<string>('cloud_cli', {
      provider,
      args,
      secret: options.secret ?? null,
      timeoutSecs: options.timeoutSecs ?? null,
      workdir: options.workdir ?? null,
      account: options.account || null
    }),
  /** Calls a provider's REST API (Render, Fly.io, Cloudflare) with the account's saved token */
  cloudApi: (
    provider: CloudProvider,
    method: string,
    path: string,
    body?: unknown,
    account?: string
  ) =>
    invoke<unknown>('cloud_api', {
      provider,
      method,
      path,
      body: body ?? null,
      account: account || null
    }),
  cloudTokenStatus: (provider: CloudProvider, account?: string) =>
    invoke<boolean>('cloud_token_status', { provider, account: account || null }),
  cloudTokenSet: (provider: CloudProvider, token: string, account?: string) =>
    invoke<void>('cloud_token_set', { provider, token, account: account || null }),
  cloudTokenDelete: (provider: CloudProvider, account?: string) =>
    invoke<void>('cloud_token_delete', { provider, account: account || null }),

  /** Backup tools for an engine; `dir` is a folder searched before PATH */
  backupTools: (engine: Engine, dir?: string | null) =>
    invoke<BackupTool[]>('backup_tools', { engine, dir: dir || null }),
  backupPreview: (id: string, job: BackupJob, dir?: string | null) =>
    invoke<string>('backup_preview', { id, job, dir: dir || null }),
  backupInspect: (id: string, path: string, dir?: string | null) =>
    invoke<BackupInspection>('backup_inspect', { id, path, dir: dir || null }),
  /** Runs to completion; output arrives as `backup-progress` events tagged with `jobId` */
  backupRun: (id: string, jobId: string, job: BackupJob, dir?: string | null) =>
    invoke<BackupOutcome>('backup_run', { id, jobId, job, dir: dir || null }),
  backupCancel: (jobId: string) => invoke<void>('backup_cancel', { jobId }),
  /** Shows the error log file in the OS file manager */
  logsReveal: () => invoke<void>('logs_reveal'),
  /** The end of the error log; empty when nothing has failed */
  logsRead: () => invoke<string>('logs_read')
}
