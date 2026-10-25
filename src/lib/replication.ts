/**
 * Replication status for MySQL and MariaDB on the server tab: the replica's channels
 * (MariaDB's named connections), and on a primary its binary log and connected replicas.
 * Statements are picked by server version, since both renamed MASTER/SLAVE to SOURCE/REPLICA
 * at different times; column names are normalized the same way so one parser reads them all.
 */
import type { Cell, ResultSet, ServerInfo } from './api'
import { isMariaDb, mariaDbVersion, type ServerVersion } from './mariadb'
import { literal } from './sql'

type InfoLike = Pick<ServerInfo, 'product' | 'version'> | null | undefined

/** MySQL's version (null for MariaDB or an unparseable version string). */
export function mysqlVersion(info: InfoLike): ServerVersion | null {
  if (!info || isMariaDb(info)) return null
  const match =
    /(\d+)\.(\d+)(?:\.(\d+))?/.exec(info.version) ?? /(\d+)\.(\d+)(?:\.(\d+))?/.exec(info.product)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)]
}

/** True when `version` is `min` or newer; an unknown version counts as current. */
function atLeast(version: ServerVersion | null, min: ServerVersion): boolean {
  if (!version) return true
  for (let i = 0; i < 3; i++) if (version[i] !== min[i]) return version[i] > min[i]
  return true
}

export interface ReplicationQueries {
  /** One row per channel / named connection */
  replicas: string
  /** server_id, log_bin, binlog_format, read_only and the GTID positions */
  variables: string
  /** Current binary log file and position */
  binlog: string
  /** Replicas registered with this server */
  hosts: string
  /** Binlog dump threads, one per connected replica */
  dumps: string
}

const DUMPS_SQL = `SELECT ID AS id, USER AS user, HOST AS host, TIME AS seconds, STATE AS state
FROM information_schema.PROCESSLIST WHERE COMMAND LIKE 'Binlog Dump%' ORDER BY ID`

/**
 * The statements for this server. MariaDB lists every named connection with SHOW ALL ... STATUS
 * (REPLICAS from 10.5.1); MySQL says REPLICA from 8.0.22 and BINARY LOG STATUS from 8.2,
 * and 8.4 dropped the old spellings.
 */
export function replicationQueries(info: InfoLike): ReplicationQueries {
  if (isMariaDb(info)) {
    const v = mariaDbVersion(info)
    const replica = atLeast(v, [10, 5, 1])
    return {
      replicas: replica ? 'SHOW ALL REPLICAS STATUS' : 'SHOW ALL SLAVES STATUS',
      variables: `SELECT @@server_id AS server_id, @@log_bin AS log_bin, @@binlog_format AS binlog_format,
  @@read_only AS read_only, @@gtid_slave_pos AS gtid_slave_pos,
  @@gtid_current_pos AS gtid_current_pos, @@gtid_binlog_pos AS gtid_binlog_pos`,
      binlog: atLeast(v, [10, 5, 2]) ? 'SHOW BINLOG STATUS' : 'SHOW MASTER STATUS',
      hosts: replica ? 'SHOW REPLICA HOSTS' : 'SHOW SLAVE HOSTS',
      dumps: DUMPS_SQL
    }
  }
  const v = mysqlVersion(info)
  const replica = atLeast(v, [8, 0, 22])
  return {
    replicas: replica ? 'SHOW REPLICA STATUS' : 'SHOW SLAVE STATUS',
    variables: `SELECT @@server_id AS server_id, @@log_bin AS log_bin, @@binlog_format AS binlog_format,
  @@read_only AS read_only, @@gtid_mode AS gtid_mode, @@gtid_executed AS gtid_executed`,
    binlog: atLeast(v, [8, 2, 0]) ? 'SHOW BINARY LOG STATUS' : 'SHOW MASTER STATUS',
    hosts: replica ? 'SHOW REPLICAS' : 'SHOW SLAVE HOSTS',
    dumps: DUMPS_SQL
  }
}

/** Column name with MASTER/SLAVE spelled SOURCE/REPLICA, lowercased: Seconds_Behind_Master → seconds_behind_source. */
export function normalizeColumn(name: string): string {
  return name
    .toLowerCase()
    .replace(/master/g, 'source')
    .replace(/slave/g, 'replica')
}

type Row = Map<string, string | null>

function cellText(v: Cell | undefined): string | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'boolean') return v ? '1' : '0'
  return v
}

function rowsOf(set: ResultSet | null | undefined): Row[] {
  if (!set) return []
  const names = set.columns.map((c) => normalizeColumn(c.name))
  return set.rows.map((r) => new Map(names.map((n, i) => [n, cellText(r[i])])))
}

/** The first non-empty value among `keys`. */
function pick(row: Row, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = row.get(k)
    if (v !== null && v !== undefined && v.trim() !== '') return v.trim()
  }
  return null
}

function num(v: string | null): number | null {
  if (v === null || !/^-?\d+(\.\d+)?$/.test(v)) return null
  return Number(v)
}

export type ThreadState = 'running' | 'connecting' | 'stopped' | 'unknown'

function threadState(v: string | null): ThreadState {
  switch (v?.toLowerCase()) {
    case 'yes':
      return 'running'
    case 'connecting':
      return 'connecting'
    case 'no':
      return 'stopped'
    default:
      return 'unknown'
  }
}

export interface ReplicationError {
  number: number
  message: string
  /** When the error happened (MySQL only), as YYYY-MM-DD HH:MM:SS */
  at: string | null
}

/** MySQL stamps errors as YYMMDD HH:MM:SS. */
function errorTime(v: string | null): string | null {
  if (!v) return null
  const m = /^(\d{2})(\d{2})(\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(v)
  return m ? `20${m[1]}-${m[2]}-${m[3]} ${m[4]}` : v
}

function replicationError(row: Row, kind: 'io' | 'sql'): ReplicationError | null {
  const number = num(pick(row, `last_${kind}_errno`)) ?? 0
  const message = pick(row, `last_${kind}_error`)
  if (!number && !message) return null
  return {
    number,
    message: message ?? '',
    at: errorTime(pick(row, `last_${kind}_error_timestamp`))
  }
}

/** GTID sets wrap after each comma in MySQL's output. */
function gtidSet(v: string | null): string | null {
  return v === null ? null : v.replace(/\s*\n\s*/g, '')
}

export interface ReplicaChannel {
  /** MariaDB connection name or MySQL channel; '' is the default one */
  name: string
  sourceHost: string | null
  sourcePort: string | null
  sourceUser: string | null
  sourceServerId: string | null
  io: ThreadState
  sql: ThreadState
  /** What the IO / SQL threads are doing, e.g. "Waiting for source to send event" */
  ioState: string | null
  sqlState: string | null
  /** Seconds_Behind_Master / Seconds_Behind_Source; null while the SQL thread is stopped */
  lagSeconds: number | null
  /** Configured delay (MASTER_DELAY / SOURCE_DELAY) in seconds */
  delaySeconds: number | null
  /** The source binlog the IO thread has read up to */
  sourceLogFile: string | null
  readSourceLogPos: string | null
  /** The relay log the SQL thread is applying */
  relayLogFile: string | null
  relayLogPos: string | null
  /** The source binlog position the SQL thread has executed up to */
  relaySourceLogFile: string | null
  execSourceLogPos: string | null
  ioError: ReplicationError | null
  sqlError: ReplicationError | null
  /** MariaDB Using_Gtid (No, Slave_Pos, Current_Pos); MySQL "Auto_Position" or "No" */
  usingGtid: string | null
  /** MariaDB: the GTID position the IO thread has received */
  gtidIoPos: string | null
  /** MySQL GTID sets */
  retrievedGtidSet: string | null
  executedGtidSet: string | null
}

/** Rows of SHOW [ALL] REPLICA(S) / SLAVE(S) STATUS, from MariaDB or MySQL. */
export function parseReplicaStatus(set: ResultSet | null | undefined): ReplicaChannel[] {
  return rowsOf(set).map((row) => {
    const autoPosition = pick(row, 'auto_position')
    return {
      name: pick(row, 'connection_name', 'channel_name') ?? '',
      sourceHost: pick(row, 'source_host'),
      sourcePort: pick(row, 'source_port'),
      sourceUser: pick(row, 'source_user'),
      sourceServerId: pick(row, 'source_server_id'),
      io: threadState(pick(row, 'replica_io_running')),
      sql: threadState(pick(row, 'replica_sql_running')),
      ioState: pick(row, 'replica_io_state'),
      sqlState: pick(row, 'replica_sql_running_state', 'replica_sql_state'),
      lagSeconds: num(pick(row, 'seconds_behind_source')),
      delaySeconds: num(pick(row, 'sql_delay')),
      sourceLogFile: pick(row, 'source_log_file'),
      readSourceLogPos: pick(row, 'read_source_log_pos'),
      relayLogFile: pick(row, 'relay_log_file'),
      relayLogPos: pick(row, 'relay_log_pos'),
      relaySourceLogFile: pick(row, 'relay_source_log_file'),
      execSourceLogPos: pick(row, 'exec_source_log_pos'),
      ioError: replicationError(row, 'io'),
      sqlError: replicationError(row, 'sql'),
      usingGtid:
        pick(row, 'using_gtid') ??
        (autoPosition === null ? null : autoPosition === '1' ? 'Auto_Position' : 'No'),
      gtidIoPos: pick(row, 'gtid_io_pos'),
      retrievedGtidSet: gtidSet(pick(row, 'retrieved_gtid_set')),
      executedGtidSet: gtidSet(pick(row, 'executed_gtid_set'))
    }
  })
}

export type ChannelHealth = 'ok' | 'warning' | 'error'

/** Lag at or above this many seconds (beyond any configured delay) is a warning. */
export const LAG_WARNING_SECONDS = 60

/** Errored, stopped or connecting, or lagging; a configured delay isn't lag. */
export function channelHealth(c: ReplicaChannel): ChannelHealth {
  if (c.ioError || c.sqlError) return 'error'
  if (c.io !== 'running' || c.sql !== 'running') return 'warning'
  if (c.lagSeconds !== null && c.lagSeconds - (c.delaySeconds ?? 0) >= LAG_WARNING_SECONDS)
    return 'warning'
  return 'ok'
}

/** 0 s, 42 s, 3 min 5 s, 2 h 10 min. */
export function formatLag(seconds: number | null): string {
  if (seconds === null) return '—'
  if (seconds < 60) return `${seconds} s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${seconds % 60} s`
  return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`
}

export interface ServerReplicationVars {
  serverId: string | null
  logBin: boolean
  binlogFormat: string | null
  readOnly: boolean
  /** MariaDB */
  gtidSlavePos: string | null
  gtidCurrentPos: string | null
  gtidBinlogPos: string | null
  /** MySQL */
  gtidMode: string | null
  gtidExecuted: string | null
}

const truthy = (v: string | null): boolean => v === '1' || v?.toUpperCase() === 'ON'

export function parseReplicationVars(
  set: ResultSet | null | undefined
): ServerReplicationVars | null {
  const row = rowsOf(set)[0]
  if (!row) return null
  return {
    serverId: pick(row, 'server_id'),
    logBin: truthy(pick(row, 'log_bin')),
    binlogFormat: pick(row, 'binlog_format'),
    readOnly: truthy(pick(row, 'read_only')),
    gtidSlavePos: pick(row, 'gtid_replica_pos'),
    gtidCurrentPos: pick(row, 'gtid_current_pos'),
    gtidBinlogPos: pick(row, 'gtid_binlog_pos'),
    gtidMode: pick(row, 'gtid_mode'),
    gtidExecuted: gtidSet(pick(row, 'gtid_executed'))
  }
}

export interface BinlogStatus {
  file: string
  position: string | null
  /** MySQL reports its gtid_executed here */
  executedGtidSet: string | null
}

/** SHOW BINARY LOG STATUS / SHOW BINLOG STATUS / SHOW MASTER STATUS; null with binary logging off. */
export function parseBinlogStatus(set: ResultSet | null | undefined): BinlogStatus | null {
  const row = rowsOf(set)[0]
  const file = row ? pick(row, 'file') : null
  if (!row || !file) return null
  return {
    file,
    position: pick(row, 'position'),
    executedGtidSet: gtidSet(pick(row, 'executed_gtid_set'))
  }
}

export interface ReplicaHost {
  serverId: string | null
  host: string | null
  port: string | null
  sourceId: string | null
  uuid: string | null
}

/** SHOW REPLICAS / SHOW REPLICA HOSTS / SHOW SLAVE HOSTS. */
export function parseReplicaHosts(set: ResultSet | null | undefined): ReplicaHost[] {
  return rowsOf(set).map((row) => ({
    serverId: pick(row, 'server_id'),
    host: pick(row, 'host'),
    port: pick(row, 'port'),
    sourceId: pick(row, 'source_id'),
    uuid: pick(row, 'replica_uuid')
  }))
}

export interface DumpThread {
  id: string | null
  user: string | null
  host: string | null
  seconds: number | null
  state: string | null
}

export function parseDumpThreads(set: ResultSet | null | undefined): DumpThread[] {
  return rowsOf(set).map((row) => ({
    id: pick(row, 'id'),
    user: pick(row, 'user'),
    host: pick(row, 'host'),
    seconds: num(pick(row, 'seconds')),
    state: pick(row, 'state')
  }))
}

/**
 * What to tell the user when a status statement is refused. The server names the privileges it
 * wants: REPLICATION CLIENT on MySQL, SLAVE MONITOR / BINLOG MONITOR / REPLICATION MASTER ADMIN
 * on MariaDB 10.5+.
 */
export function replicationPrivilegeHint(error: string, mariadb: boolean): string | null {
  if (!/access denied|privilege|command denied/i.test(error)) return null
  const named = /you need \(at least one of\) the (.+?) privilege/i.exec(error)?.[1]
  const wanted = named ?? (mariadb ? 'SLAVE MONITOR' : 'REPLICATION CLIENT')
  const first =
    wanted
      .split(',')
      .map((p) => p.trim())
      .find((p) => p !== 'SUPER') ?? wanted
  return `Reading replication status needs the ${wanted} privilege. An administrator can grant it with GRANT ${first} ON *.* TO the user this connection signs in as.`
}

export type ReplicaAction = 'start' | 'stop'
export type ReplicaThread = 'all' | 'io' | 'sql'

/**
 * START / STOP for one channel, or every channel when `channel` is null. MariaDB names a
 * connection after the verb (START REPLICA 'crm', START ALL REPLICAS); MySQL uses FOR CHANNEL.
 */
export function replicaActionSql(
  info: InfoLike,
  action: ReplicaAction,
  channel: string | null,
  thread: ReplicaThread = 'all'
): string {
  const verb = action === 'start' ? 'START' : 'STOP'
  const threads = thread === 'io' ? ' IO_THREAD' : thread === 'sql' ? ' SQL_THREAD' : ''
  if (isMariaDb(info)) {
    const modern = atLeast(mariaDbVersion(info), [10, 5, 1])
    if (channel === null) return `${verb} ALL ${modern ? 'REPLICAS' : 'SLAVES'}${threads}`
    const name = channel ? ` ${literal('mysql', channel)}` : ''
    return `${verb} ${modern ? 'REPLICA' : 'SLAVE'}${name}${threads}`
  }
  const noun = atLeast(mysqlVersion(info), [8, 0, 22]) ? 'REPLICA' : 'SLAVE'
  const forChannel = channel === null ? '' : ` FOR CHANNEL ${literal('mysql', channel)}`
  return `${verb} ${noun}${threads}${forChannel}`
}

export interface ConnectedReplica {
  host: string
  serverId: string | null
  /** The binlog dump thread serving it, e.g. "9 (repl)" */
  thread: string | null
  seconds: number | null
  state: string | null
}

const stripPort = (host: string | null): string | null => host?.replace(/:\d+$/, '') ?? null

/**
 * Registered replicas joined to the binlog dump threads serving them by IP address. A replica
 * shows up in only one list when it didn't register its host (MySQL leaves Host empty without
 * report_host) or its dump thread isn't visible without the PROCESS privilege.
 */
export function connectedReplicas(hosts: ReplicaHost[], dumps: DumpThread[]): ConnectedReplica[] {
  const left = [...dumps]
  const thread = (d: DumpThread): string => `${d.id ?? '?'} (${d.user ?? '?'})`
  const rows = hosts.map((h): ConnectedReplica => {
    let i = h.host ? left.findIndex((d) => stripPort(d.host) === h.host) : -1
    // One unnamed replica and one dump thread are the same connection
    if (i < 0 && !h.host && hosts.length === 1 && left.length === 1) i = 0
    const d = i >= 0 ? left.splice(i, 1)[0] : null
    const host = h.host ?? stripPort(d?.host ?? null) ?? '?'
    return {
      host: h.port ? `${host}:${h.port}` : host,
      serverId: h.serverId,
      thread: d ? thread(d) : null,
      seconds: d?.seconds ?? null,
      state: d?.state ?? null
    }
  })
  for (const d of left)
    rows.push({
      host: d.host ?? '?',
      serverId: null,
      thread: thread(d),
      seconds: d.seconds,
      state: d.state
    })
  return rows
}
