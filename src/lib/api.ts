import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export type Engine = 'postgres' | 'mysql' | 'mssql' | 'babelfish' | 'mongo' | 'sqlite' | 'redis'
export type SslMode = 'disable' | 'prefer' | 'require' | 'verify-ca' | 'verify-full'
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
  /** Ignored by the verify modes */
  trustServerCertificate: boolean
  /** CA certificate file (PEM) trusted in addition to the system roots */
  sslRootCert?: string
  /** Client certificate for mutual TLS: PEM, or a .p12/.pfx bundle */
  sslClientCert?: string
  /** Private key for sslClientCert (PEM, PKCS#8) */
  sslClientKey?: string
  uri: string
  authSource: string
  /** MongoDB replica set name (host and port form) */
  replicaSet?: string
  /** MongoDB read preference; empty keeps the default */
  readPreference?: string
  savePassword: boolean
  readOnly: boolean
  /** Writes need an extra confirmation, and destructive ones the connection's name typed */
  production?: boolean
  color: string
  group: string
  lastUsed?: number | null
  /** The cloud resource this connection was found in or provisioned as */
  cloud?: CloudRef | null
  /** SSH server the connection is tunnelled through */
  ssh?: SshConfig | null
}

export type SshAuth = 'agent' | 'key' | 'password'

export interface SshConfig {
  enabled: boolean
  /** Host name or a Host alias from ~/.ssh/config */
  host: string
  /** 0 for ssh's default */
  port: number
  user: string
  auth: SshAuth
  keyFile: string
  /** ssh -J destinations */
  jumpHost: string
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
  /** Keys in a Redis keyspace */
  keys?: number
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
  /** MariaDB CREATE PACKAGE (with its body, when it has one) */
  | 'package'
  | 'synonym'
  | 'collection'
  | 'timeseries'
  /** MySQL / MariaDB scheduled event */
  | 'event'
  /** PostgreSQL aggregate and window function: listed with routines, but not callable alone */
  | 'aggregate'
  | 'window_function'

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
  /** MySQL character set of a text column */
  charset?: string | null
  /** MySQL / SQL Server collation of a text column */
  collation?: string | null
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
  /** PostgreSQL only: security, volatility and the other function attributes */
  attributes?: RoutineAttributes
}

/** Attributes of a PostgreSQL function or procedure, from `pg_proc`. */
export interface RoutineAttributes {
  /** Runs with the owner's privileges rather than the caller's */
  securityDefiner: boolean
  volatility: 'IMMUTABLE' | 'STABLE' | 'VOLATILE'
  /** Returns NULL on NULL input without being called */
  strict: boolean
  parallel: 'SAFE' | 'RESTRICTED' | 'UNSAFE'
  leakproof: boolean
  cost: number
  /** Estimated rows for set-returning functions; 0 otherwise */
  rows: number
  /** `SET` options, e.g. `search_path=pg_catalog, pg_temp` */
  config: string[]
}

export interface CompletionTable {
  schema: string | null
  name: string
  columns: string[]
  /** Outgoing foreign keys, for join suggestions */
  foreignKeys: CompletionKey[]
  /** Where the schema falls in PostgreSQL's search_path (1 is searched first) */
  searchRank?: number
}

export interface CompletionKey {
  columns: string[]
  refSchema: string | null
  refTable: string
  refColumns: string[]
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
  /** Whether the session was left inside a transaction; null when unknown */
  inTransaction: boolean | null
}

export interface ExecOptions {
  maxRows?: number
  /** Block writes for this call even on a writable connection */
  readOnly?: boolean
  /** Cancels the statement after this many seconds; 0 or absent never times out */
  timeoutSecs?: number
  /** Bytes of each binary cell to send (default 4096); the rest is summarized */
  maxBinaryBytes?: number
  /** The caller already confirmed this write, so the production guard skips it (not sent) */
  confirmed?: boolean
}

/** What a write guard is asked about: SQL text, a MongoDB request or a Redis request. */
export type GuardedWrite = { sql: string } | { request: MongoRequest } | { redis: RedisRequest }

type WriteGuard = (id: string, write: GuardedWrite) => Promise<boolean>

let writeGuard: WriteGuard | null = null

/** Installs the check every `execute` and `mongo` call passes through (see production.ts). */
export function setWriteGuard(guard: WriteGuard | null): void {
  writeGuard = guard
}

async function guarded(id: string, write: GuardedWrite, options?: ExecOptions): Promise<void> {
  if (!writeGuard || options?.confirmed) return
  if (!(await writeGuard(id, write))) {
    const declined: AppError = { code: 'error', message: 'Not run: the change was not confirmed' }
    throw declined
  }
}

function wireOptions(options?: ExecOptions): ExecOptions | undefined {
  if (!options) return undefined
  const { confirmed: _, ...rest } = options
  return rest
}

/** Formats `query_export` streams to disk */
export type StreamFormat = 'csv' | 'tsv' | 'json' | 'xlsx'

/** Extended JSON value as produced by the backend. */
export type Ejson = unknown

/** Cursor modifiers such as `.hint()` and `.maxTimeMS()`, for find, aggregate and count. */
export interface MongoCursorOptions {
  /** Index keys or an index name */
  hint?: Ejson
  maxTimeMS?: number
  collation?: Ejson
  allowDiskUse?: boolean
  comment?: Ejson
  readPreference?: string
  readConcern?: string
}

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
      options?: MongoCursorOptions
    }
  | {
      op: 'aggregate'
      database: string
      collection: string
      pipeline: Ejson[]
      options?: MongoCursorOptions
    }
  | {
      op: 'count'
      database: string
      collection: string
      filter?: Ejson
      options?: MongoCursorOptions
    }
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

export type MongoExportFormat = 'json' | 'jsonl' | 'csv'

/** A whole find (or, with `pipeline`, aggregation) result written to a file. */
export interface MongoExportRequest {
  database: string
  collection: string
  filter?: Ejson
  projection?: Ejson
  sort?: Ejson
  pipeline?: Ejson[]
  format: MongoExportFormat
}

export interface MongoExportSummary {
  documents: number
  bytes: number
  elapsedMs: number
  cancelled: boolean
  /** CSV only: fields first seen after the header was written */
  droppedFields: string[]
}

/** A Redis key, field or value: text when it's UTF-8, hex otherwise. */
export type RData = string | { $hex: string }

export type RedisKeyType = 'string' | 'list' | 'hash' | 'set' | 'zset' | 'stream' | 'ReJSON-RL'

export type RedisRequest =
  | {
      op: 'scan'
      database: string
      cursor?: string | null
      pattern?: RData
      keyType?: string
      count?: number
    }
  | {
      op: 'get'
      database: string
      key: RData
      cursor?: string | null
      offset?: number
      count?: number
    }
  | {
      op: 'set'
      database: string
      key: RData
      value: RData
      ttlMs?: number | null
      keepTtl?: boolean
      onlyNew?: boolean
    }
  | { op: 'hashSet'; database: string; key: RData; field: RData; value: RData; onlyNew?: boolean }
  | { op: 'hashDelete'; database: string; key: RData; fields: RData[] }
  | { op: 'listPush'; database: string; key: RData; values: RData[]; head?: boolean }
  | { op: 'listSet'; database: string; key: RData; index: number; value: RData; expected?: RData }
  | { op: 'listRemove'; database: string; key: RData; index: number; expected?: RData }
  | { op: 'setAdd' | 'setRemove'; database: string; key: RData; members: RData[] }
  /** `score` as text too: `inf`, `-inf`, which JSON numbers can't carry */
  | { op: 'zsetAdd'; database: string; key: RData; member: RData; score: number | string }
  | { op: 'zsetRemove'; database: string; key: RData; members: RData[] }
  | { op: 'streamAdd'; database: string; key: RData; id?: string; fields: [RData, RData][] }
  | { op: 'streamDelete'; database: string; key: RData; ids: string[] }
  | { op: 'jsonSet'; database: string; key: RData; json: string }
  | { op: 'expire'; database: string; key: RData; ttlMs?: number | null }
  | { op: 'rename'; database: string; key: RData; newKey: RData }
  | { op: 'delete'; database: string; keys: RData[] }
  | { op: 'deleteMatching'; database: string; pattern: RData }
  | { op: 'flush'; database: string }
  | { op: 'command'; database: string; args: RData[] }
  /** Many commands in one round trip; rejected ones come back in `entries` as { index, error } */
  | { op: 'pipeline'; database: string; commands: RData[][] }

/** A server reply, tagged the way redis-cli prints it. */
export type RedisReply =
  | { t: 'nil' }
  | { t: 'int'; v: number | string }
  | { t: 'double'; v: number }
  | { t: 'bool'; v: boolean }
  | { t: 'bulk'; v: RData }
  | { t: 'status'; v: string }
  | { t: 'error'; v: string }
  | { t: 'array' | 'set'; v: RedisReply[] }
  | { t: 'map'; v: [RedisReply, RedisReply][] }

export interface RedisKeyEntry {
  key: RData
  type: string
  /** Milliseconds left; -1 when the key never expires */
  ttl: number
}

export interface RedisOutput {
  kind: 'keys' | 'key' | 'reply'
  keys: RedisKeyEntry[]
  /** Where the next page continues; null when there is no more */
  cursor: string | null
  scanned: number
  type: string | null
  ttl: number | null
  encoding: string | null
  memory: number | null
  length: number | null
  value: RData | null
  entries: Record<string, unknown>[]
  groups: Record<string, unknown>[]
  truncated: boolean
  reply: RedisReply | null
  elapsedMs: number
  cancelled: boolean
}

export interface PubSubMessage {
  channel: string
  pattern: string | null
  payload: RData
  /** Unix time in milliseconds */
  at: number
}

export interface PubSubBatch {
  subscription: string
  messages: PubSubMessage[]
  dropped: number
  error: string | null
}

/** A PostgreSQL `NOTIFY` received by a Notifications tab */
export interface PgNotification {
  channel: string
  payload: string
  /** The sending backend's process id */
  pid: number
  /** Unix time in milliseconds */
  at: number
}

export interface PgNotifyBatch {
  listener: string
  notifications: PgNotification[]
  dropped: number
  /** Set once when the listening session ends on its own */
  error: string | null
}

export interface AppError {
  code:
    | 'error'
    | 'password_required'
    | 'not_connected'
    | 'unknown_connection'
    | 'unsupported'
    | 'io'
    | 'host_key_unknown'
  message: string
  /** With 'host_key_unknown': the SSH server's key, for the user to confirm */
  hostKey?: HostKeyPrompt
}

export interface HostKeyPrompt {
  /** Passed to sshTrustHostKey */
  token: string
  host: string
  /** SHA256:... */
  fingerprint: string
  keyType: string
  /** known_hosts already has a key of another type for this server: not a first contact */
  otherKeyTypesKnown: boolean
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
  /** `sshSecret` is the SSH password or key passphrase, saved with the connection */
  connectionSave: (config: ConnectionConfig, password?: string | null, sshSecret?: string | null) =>
    invoke<ConnectionConfig>('connection_save', {
      config,
      password: password ?? null,
      sshSecret: sshSecret || null
    }),
  connectionDelete: (id: string) => invoke<void>('connection_delete', { id }),
  connectionTest: (config: ConnectionConfig, password?: string | null, sshSecret?: string | null) =>
    invoke<ServerInfo>('connection_test', {
      config,
      password: password ?? null,
      sshSecret: sshSecret || null
    }),
  connectionOpen: (id: string, password?: string | null, remember?: boolean) =>
    invoke<ServerInfo>('connection_open', { id, password: password ?? null, remember }),
  connectionClose: (id: string) => invoke<void>('connection_close', { id }),
  /** Adds the SSH host key from a 'host_key_unknown' error to known_hosts */
  sshTrustHostKey: (token: string) => invoke<void>('ssh_trust_host_key', { token }),
  /** Applies Settings' connect timeout to connections opened from now on */
  limitsSet: (connectTimeoutSecs: number) => invoke<void>('limits_set', { connectTimeoutSecs }),

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

  execute: async (
    id: string,
    session: string,
    database: string,
    sql: string,
    options?: ExecOptions
  ): Promise<ExecOutput> => {
    await guarded(id, { sql }, options)
    return invoke<ExecOutput>('query_execute', {
      id,
      session,
      database,
      sql,
      options: wireOptions(options)
    })
  },
  cancel: (id: string, session: string) => invoke<void>('query_cancel', { id, session }),
  /** Runs `sql` and writes every row of result set `set` to `path` (picked in a save dialog) */
  exportQuery: (
    id: string,
    session: string,
    database: string,
    sql: string,
    format: StreamFormat,
    path: string,
    set = 0
  ) => invoke<ExecOutput>('query_export', { id, session, database, sql, format, path, set }),
  closeSession: (id: string, session: string) => invoke<void>('session_close', { id, session }),

  mongo: async (
    id: string,
    session: string,
    request: MongoRequest,
    options?: ExecOptions
  ): Promise<MongoOutput> => {
    await guarded(id, { request }, options)
    return invoke<MongoOutput>('mongo_execute', {
      id,
      session,
      request,
      options: wireOptions(options)
    })
  },
  mongoExport: (id: string, session: string, request: MongoExportRequest, path: string) =>
    invoke<MongoExportSummary>('mongo_export', { id, session, request, path }),

  redis: async (
    id: string,
    session: string,
    request: RedisRequest,
    options?: ExecOptions
  ): Promise<RedisOutput> => {
    await guarded(id, { redis: request }, options)
    return invoke<RedisOutput>('redis_execute', {
      id,
      session,
      request,
      options: wireOptions(options)
    })
  },
  /** Messages arrive through `onRedisMessages`, tagged with `subscription` */
  redisSubscribe: (id: string, subscription: string, channels: string[], patterns: string[]) =>
    invoke<void>('redis_subscribe', { id, subscription, channels, patterns }),
  redisUnsubscribe: (id: string, subscription: string) =>
    invoke<void>('redis_unsubscribe', { id, subscription }),
  onRedisMessages: (handler: (batch: PubSubBatch) => void): Promise<UnlistenFn> =>
    listen<PubSubBatch>('redis-pubsub', (e) => handler(e.payload)),
  /** LISTENs from the listener's own session; returns every channel it listens on */
  pgListen: (id: string, listener: string, database: string, channels: string[]) =>
    invoke<string[]>('pg_listen', { id, listener, database, channels }),
  /** UNLISTENs `channels`, or all of them when empty; returns the ones left */
  pgUnlisten: (id: string, listener: string, channels: string[]) =>
    invoke<string[]>('pg_unlisten', { id, listener, channels }),
  pgNotify: (id: string, listener: string, database: string, channel: string, payload: string) =>
    invoke<void>('pg_notify', { id, listener, database, channel, payload }),
  onPgNotifications: (handler: (batch: PgNotifyBatch) => void): Promise<UnlistenFn> =>
    listen<PgNotifyBatch>('pg-notify', (e) => handler(e.payload)),

  writeText: (path: string, contents: string) =>
    invoke<void>('file_write_text', { path, contents }),
  writeBytes: (path: string, contents: Uint8Array) =>
    invoke<void>('file_write_bytes', contents, {
      headers: { 'x-path': encodeURIComponent(path) }
    }),
  writeXlsx: (path: string, columns: ColumnMeta[], rows: Cell[][]) =>
    invoke<void>('file_write_xlsx', { path, columns, rows }),
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
