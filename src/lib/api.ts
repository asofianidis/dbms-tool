import { invoke } from '@tauri-apps/api/core'

export type Engine = 'postgres' | 'mysql' | 'mssql' | 'babelfish' | 'mongo'
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

export type CloudProvider = 'aws' | 'gcp' | 'azure'

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
}

export interface CloudTool {
  provider: CloudProvider
  /** Resolved executable, null when the CLI isn't installed */
  path: string | null
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
    options: { secret?: string; timeoutSecs?: number } = {}
  ) =>
    invoke<string>('cloud_cli', {
      provider,
      args,
      secret: options.secret ?? null,
      timeoutSecs: options.timeoutSecs ?? null
    })
}
