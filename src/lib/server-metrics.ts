import { api, type ConnectionConfig, type ResultSet } from './api'
import { formatBytes } from './format'

/** Raw readings from one poll, keyed by normalized column / variable / document path. */
export type Raw = Record<string, string | null>
/** Derived metric values for one poll. */
export type Point = Record<string, number | null>

export type Probe =
  | { id: string; sql: string; shape: 'row' | 'pairs' }
  | { id: string; command: Record<string, unknown>; prefix?: string }

export type Unit = 'count' | 'perSec' | 'bytes' | 'bytesPerSec' | 'percent' | 'seconds'

export interface MetricSpec {
  key: string
  label: string
  unit: Unit
  hint: string
}

export interface MeterSpec {
  /** Point key holding a 0–100 percentage */
  key: string
  label: string
  detail: (raw: Raw, point: Point) => string | null
  /** Usage thresholds that turn the fill amber / red; omit for usage that's healthy when full */
  warn?: number
  danger?: number
}

export interface Fact {
  label: string
  value: string
}

export interface ServerDashboardSpec {
  probes: Probe[]
  derive: (next: Raw, prev: Raw | null, seconds: number) => Point
  /** The first tile is the one charted by default */
  tiles: MetricSpec[]
  meters: MeterSpec[]
  facts: (raw: Raw) => Fact[]
  note?: string
}

export const metricKey = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')

function cellText(cell: ResultSet['rows'][number][number]): string | null {
  if (cell == null) return null
  if (typeof cell === 'boolean') return cell ? '1' : '0'
  return cell
}

/** A single wide row: one reading per column. */
export function rowToRaw(set: ResultSet): Raw {
  const raw: Raw = {}
  const row = set.rows[0]
  if (!row) return raw
  set.columns.forEach((c, i) => (raw[metricKey(c.name)] = cellText(row[i])))
  return raw
}

/** Name/value rows, as from SHOW STATUS or a counters view. */
export function pairsToRaw(set: ResultSet): Raw {
  const raw: Raw = {}
  for (const row of set.rows) {
    const name = cellText(row[0])
    if (name) raw[metricKey(name)] = cellText(row[1])
  }
  return raw
}

function scalar(value: unknown): string | null | undefined {
  if (value == null) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'object' && !Array.isArray(value)) {
    const o = value as Record<string, unknown>
    const keys = Object.keys(o)
    if (keys.length === 1 && keys[0].startsWith('$')) {
      const inner = o[keys[0]]
      if (keys[0] === '$date') {
        const ms = typeof inner === 'string' ? Date.parse(inner) : Number(scalar(inner))
        return Number.isFinite(ms) ? new Date(ms).toISOString() : null
      }
      return typeof inner === 'string' || typeof inner === 'number' ? String(inner) : undefined
    }
  }
  return undefined
}

/** Flattens an Extended JSON document into dotted paths; arrays are skipped. */
export function documentToRaw(doc: unknown, prefix = ''): Raw {
  const raw: Raw = {}
  const walk = (value: unknown, path: string): void => {
    const s = scalar(value)
    if (s !== undefined) {
      if (path) raw[path] = s
      return
    }
    if (Array.isArray(value) || typeof value !== 'object') return
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      walk(v, path ? `${path}.${metricKey(k)}` : metricKey(k))
  }
  walk(doc, prefix.replace(/\.$/, ''))
  return raw
}

export function num(raw: Raw | null, key: string): number | null {
  const v = raw?.[key]
  if (v == null || v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function sum(raw: Raw | null, keys: string[]): number | null {
  let total = 0
  for (const k of keys) {
    const n = num(raw, k)
    if (n == null) return null
    total += n
  }
  return total
}

/** Per-second rate of cumulative counters; null on the first poll or after a counter reset. */
export function rate(
  next: Raw,
  prev: Raw | null,
  seconds: number,
  ...keys: string[]
): number | null {
  if (!prev || seconds <= 0) return null
  const a = sum(prev, keys)
  const b = sum(next, keys)
  if (a == null || b == null || b < a) return null
  return (b - a) / seconds
}

/**
 * Hit percentage over the poll interval, falling back to the lifetime ratio
 * when the interval had no traffic (or on the first poll).
 */
export function hitPercent(
  next: Raw,
  prev: Raw | null,
  hits: string,
  misses: string
): number | null {
  const pct = (h: number | null, m: number | null): number | null =>
    h == null || m == null || h + m <= 0 ? null : (h / (h + m)) * 100
  const h1 = num(next, hits)
  const m1 = num(next, misses)
  const h0 = num(prev, hits)
  const m0 = num(prev, misses)
  const interval =
    h1 != null && m1 != null && h0 != null && m0 != null && h1 >= h0 && m1 >= m0
      ? pct(h1 - h0, m1 - m0)
      : null
  return interval ?? pct(h1, m1)
}

export function percentOf(part: number | null, whole: number | null): number | null {
  if (part == null || whole == null || whole <= 0) return null
  return Math.min(100, Math.max(0, (part / whole) * 100))
}

const facts = (pairs: [string, string | null | undefined][]): Fact[] =>
  pairs.filter((p): p is [string, string] => !!p[1]).map(([label, value]) => ({ label, value }))

const bytesFact = (n: number | null, scale = 1): string | null =>
  n == null ? null : formatBytes(n * scale)

const usage = (used: number | null, total: number | null, scale = 1): string | null =>
  used == null || total == null
    ? null
    : `${formatBytes(used * scale)} of ${formatBytes(total * scale)}`

const POSTGRES: ServerDashboardSpec = {
  probes: [
    {
      id: 'stats',
      shape: 'row',
      sql: `SELECT
  extract(epoch FROM now() - pg_postmaster_start_time())::bigint AS uptime_s,
  a.connections, a.active, a.idle_in_tx, a.waiting, a.longest_s,
  current_setting('max_connections')::int AS max_connections,
  d.commits, d.rollbacks, d.blks_hit, d.blks_read, d.rows_returned,
  d.rows_inserted, d.rows_updated, d.rows_deleted, d.deadlocks, d.temp_bytes,
  pg_is_in_recovery()::int AS standby,
  (SELECT count(*) FROM pg_stat_replication) AS replicas,
  host(inet_server_addr()) AS address, inet_server_port() AS port,
  current_setting('shared_buffers') AS shared_buffers,
  current_setting('work_mem') AS work_mem,
  current_setting('effective_cache_size') AS effective_cache_size,
  current_setting('server_encoding') AS encoding,
  current_setting('TimeZone') AS timezone,
  version() AS version
FROM (
  SELECT count(*) AS connections,
    count(*) FILTER (WHERE state = 'active') AS active,
    count(*) FILTER (WHERE state LIKE 'idle in transaction%') AS idle_in_tx,
    count(*) FILTER (WHERE wait_event_type = 'Lock') AS waiting,
    coalesce(max(extract(epoch FROM now() - query_start))
      FILTER (WHERE state = 'active' AND pid <> pg_backend_pid()), 0)::float8 AS longest_s
  FROM pg_stat_activity WHERE backend_type = 'client backend'
) a, (
  SELECT sum(xact_commit) AS commits, sum(xact_rollback) AS rollbacks,
    sum(blks_hit) AS blks_hit, sum(blks_read) AS blks_read, sum(tup_returned) AS rows_returned,
    sum(tup_inserted) AS rows_inserted, sum(tup_updated) AS rows_updated,
    sum(tup_deleted) AS rows_deleted, sum(deadlocks) AS deadlocks, sum(temp_bytes) AS temp_bytes
  FROM pg_stat_database
) d`
    }
  ],
  derive: (next, prev, s) => ({
    uptime: num(next, 'uptime_s'),
    tps: rate(next, prev, s, 'commits', 'rollbacks'),
    rowsRead: rate(next, prev, s, 'rows_returned'),
    rowsWritten: rate(next, prev, s, 'rows_inserted', 'rows_updated', 'rows_deleted'),
    cacheHit: hitPercent(next, prev, 'blks_hit', 'blks_read'),
    active: num(next, 'active'),
    waiting: num(next, 'waiting'),
    longest: num(next, 'longest_s'),
    tempBytes: rate(next, prev, s, 'temp_bytes'),
    connections: percentOf(num(next, 'connections'), num(next, 'max_connections'))
  }),
  tiles: [
    { key: 'tps', label: 'Transactions', unit: 'perSec', hint: 'Commits and rollbacks per second' },
    {
      key: 'rowsRead',
      label: 'Rows read',
      unit: 'perSec',
      hint: 'Rows returned by scans per second'
    },
    {
      key: 'rowsWritten',
      label: 'Rows written',
      unit: 'perSec',
      hint: 'Rows inserted, updated or deleted per second'
    },
    {
      key: 'cacheHit',
      label: 'Cache hit',
      unit: 'percent',
      hint: 'Share of block reads served from shared buffers'
    },
    {
      key: 'active',
      label: 'Active queries',
      unit: 'count',
      hint: 'Client sessions currently running a statement'
    },
    {
      key: 'waiting',
      label: 'Waiting on locks',
      unit: 'count',
      hint: 'Sessions blocked waiting for a lock'
    },
    {
      key: 'longest',
      label: 'Longest query',
      unit: 'seconds',
      hint: 'Runtime of the longest statement still running'
    },
    {
      key: 'tempBytes',
      label: 'Temp files',
      unit: 'bytesPerSec',
      hint: 'Bytes spilled to temporary files per second'
    }
  ],
  meters: [
    {
      key: 'connections',
      label: 'Connections',
      detail: (raw) => `${num(raw, 'connections') ?? '—'} of ${num(raw, 'max_connections') ?? '—'}`,
      warn: 75,
      danger: 90
    }
  ],
  facts: (raw) =>
    facts([
      ['Role', num(raw, 'standby') ? 'Standby (read replica)' : 'Primary'],
      ['Streaming replicas', raw.replicas],
      ['Address', raw.address && `${raw.address}:${raw.port ?? ''}`],
      ['Platform', raw.version?.match(/\bon ([^,]+),/)?.[1]],
      ['Shared buffers', raw.shared_buffers],
      ['Effective cache size', raw.effective_cache_size],
      ['Work mem', raw.work_mem],
      ['Idle in transaction', raw.idle_in_tx],
      ['Deadlocks since reset', raw.deadlocks],
      ['Encoding', raw.encoding],
      ['Time zone', raw.timezone]
    ])
}

const MYSQL_STATUS = [
  'Uptime',
  'Threads_connected',
  'Threads_running',
  'Max_used_connections',
  'Questions',
  'Com_select',
  'Com_insert',
  'Com_update',
  'Com_delete',
  'Com_replace',
  'Bytes_received',
  'Bytes_sent',
  'Innodb_buffer_pool_read_requests',
  'Innodb_buffer_pool_reads',
  'Innodb_buffer_pool_pages_total',
  'Innodb_buffer_pool_pages_free',
  'Innodb_row_lock_current_waits',
  'Slow_queries',
  'Aborted_connects',
  'Created_tmp_disk_tables'
]

const MYSQL_VARIABLES = [
  'max_connections',
  'hostname',
  'version_compile_os',
  'version_compile_machine',
  'innodb_buffer_pool_size',
  'datadir',
  'character_set_server',
  'read_only'
]

const inList = (names: string[]): string => names.map((n) => `'${n}'`).join(', ')

/** read_requests counts every logical read; reads are the ones that missed the pool. */
function withPoolHits(raw: Raw): Raw {
  const requests = num(raw, 'innodb_buffer_pool_read_requests')
  const misses = num(raw, 'innodb_buffer_pool_reads')
  return {
    ...raw,
    pool_hits: requests == null || misses == null ? null : String(requests - misses)
  }
}

const MYSQL: ServerDashboardSpec = {
  probes: [
    {
      id: 'status',
      shape: 'pairs',
      sql: `SHOW GLOBAL STATUS WHERE Variable_name IN (${inList(MYSQL_STATUS)})`
    },
    {
      id: 'variables',
      shape: 'pairs',
      sql: `SHOW GLOBAL VARIABLES WHERE Variable_name IN (${inList(MYSQL_VARIABLES)})`
    }
  ],
  derive: (next, prev, s) => {
    const total = num(next, 'innodb_buffer_pool_pages_total')
    const free = num(next, 'innodb_buffer_pool_pages_free')
    return {
      uptime: num(next, 'uptime'),
      qps: rate(next, prev, s, 'questions'),
      selects: rate(next, prev, s, 'com_select'),
      writes: rate(next, prev, s, 'com_insert', 'com_update', 'com_delete', 'com_replace'),
      poolHit: hitPercent(
        withPoolHits(next),
        prev && withPoolHits(prev),
        'pool_hits',
        'innodb_buffer_pool_reads'
      ),
      running: num(next, 'threads_running'),
      lockWaits: num(next, 'innodb_row_lock_current_waits'),
      netIn: rate(next, prev, s, 'bytes_received'),
      netOut: rate(next, prev, s, 'bytes_sent'),
      connections: percentOf(num(next, 'threads_connected'), num(next, 'max_connections')),
      pool: percentOf(total == null || free == null ? null : total - free, total)
    }
  },
  tiles: [
    { key: 'qps', label: 'Queries', unit: 'perSec', hint: 'Statements sent by clients per second' },
    { key: 'selects', label: 'Selects', unit: 'perSec', hint: 'SELECT statements per second' },
    {
      key: 'writes',
      label: 'Writes',
      unit: 'perSec',
      hint: 'INSERT, UPDATE, DELETE and REPLACE statements per second'
    },
    {
      key: 'poolHit',
      label: 'Buffer pool hit',
      unit: 'percent',
      hint: 'Share of InnoDB reads served from the buffer pool'
    },
    {
      key: 'running',
      label: 'Threads running',
      unit: 'count',
      hint: 'Threads currently executing a statement'
    },
    {
      key: 'lockWaits',
      label: 'Row lock waits',
      unit: 'count',
      hint: 'Statements waiting for an InnoDB row lock right now'
    },
    {
      key: 'netIn',
      label: 'Network in',
      unit: 'bytesPerSec',
      hint: 'Bytes received from clients per second'
    },
    {
      key: 'netOut',
      label: 'Network out',
      unit: 'bytesPerSec',
      hint: 'Bytes sent to clients per second'
    }
  ],
  meters: [
    {
      key: 'connections',
      label: 'Connections',
      detail: (raw) =>
        `${num(raw, 'threads_connected') ?? '—'} of ${num(raw, 'max_connections') ?? '—'} · peak ${num(raw, 'max_used_connections') ?? '—'}`,
      warn: 75,
      danger: 90
    },
    {
      key: 'pool',
      label: 'Buffer pool in use',
      detail: (raw) => bytesFact(num(raw, 'innodb_buffer_pool_size'))
    }
  ],
  facts: (raw) =>
    facts([
      ['Hostname', raw.hostname],
      [
        'Platform',
        raw.version_compile_os &&
          [raw.version_compile_os, raw.version_compile_machine].filter(Boolean).join(' · ')
      ],
      ['Read only', raw.read_only && (/^(on|1)$/i.test(raw.read_only) ? 'Yes' : 'No')],
      ['Buffer pool size', bytesFact(num(raw, 'innodb_buffer_pool_size'))],
      ['Data directory', raw.datadir],
      ['Character set', raw.character_set_server],
      ['Slow queries', raw.slow_queries],
      ['Aborted connects', raw.aborted_connects],
      ['Temp tables on disk', raw.created_tmp_disk_tables]
    ])
}

function schedulerHealth(raw: Raw, field: string): number | null {
  const match = raw.cpu_record?.match(new RegExp(`<${field}>(\\d+)</${field}>`))
  return match ? Number(match[1]) : null
}

function hostCpu(raw: Raw): number | null {
  // SQL Server on Linux always reports SystemIdle as 0
  if (/linux/i.test(raw.host_platform ?? '')) return null
  const idle = schedulerHealth(raw, 'SystemIdle')
  return idle == null ? null : 100 - idle
}

const MSSQL: ServerDashboardSpec = {
  probes: [
    {
      id: 'properties',
      shape: 'row',
      sql: `SELECT CAST(SERVERPROPERTY('MachineName') AS nvarchar(256)) AS machine,
  CAST(SERVERPROPERTY('Edition') AS nvarchar(256)) AS edition,
  CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(64)) AS product_version,
  CAST(SERVERPROPERTY('ProductLevel') AS nvarchar(64)) AS product_level,
  DATEDIFF(SECOND, (SELECT create_date FROM sys.databases WHERE name = 'tempdb'), GETDATE()) AS uptime_s`
    },
    {
      id: 'counters',
      shape: 'pairs',
      sql: `SELECT RTRIM(counter_name) AS name, cntr_value AS value
FROM sys.dm_os_performance_counters
WHERE (object_name LIKE '%:SQL Statistics%' AND counter_name IN ('Batch Requests/sec', 'SQL Compilations/sec'))
  OR (object_name LIKE '%:General Statistics%' AND counter_name IN ('User Connections', 'Processes blocked'))
  OR (object_name LIKE '%:Buffer Manager%' AND counter_name IN ('Page life expectancy', 'Buffer cache hit ratio', 'Buffer cache hit ratio base'))
  OR (object_name LIKE '%:Databases%' AND RTRIM(instance_name) = '_Total' AND counter_name IN ('Transactions/sec', 'Log Bytes Flushed/sec'))
  OR (object_name LIKE '%:Locks%' AND RTRIM(instance_name) = '_Total' AND counter_name IN ('Lock Waits/sec', 'Number of Deadlocks/sec'))
  OR (object_name LIKE '%:Memory Manager%' AND counter_name IN ('Total Server Memory (KB)', 'Target Server Memory (KB)'))`
    },
    {
      id: 'system',
      shape: 'row',
      sql: `SELECT i.cpu_count, i.physical_memory_kb, m.available_physical_memory_kb,
  m.system_memory_state_desc AS memory_state
FROM sys.dm_os_sys_info i CROSS JOIN sys.dm_os_sys_memory m`
    },
    {
      id: 'cpu',
      shape: 'row',
      // Parsed client-side: XML methods need QUOTED_IDENTIFIER ON, which not every session has
      sql: `SELECT TOP (1) record AS cpu_record
FROM sys.dm_os_ring_buffers
WHERE ring_buffer_type = N'RING_BUFFER_SCHEDULER_MONITOR' AND record LIKE N'%<SystemHealth>%'
ORDER BY [timestamp] DESC`
    },
    {
      id: 'host',
      shape: 'row',
      sql: `SELECT host_platform, host_distribution, host_release FROM sys.dm_os_host_info`
    }
  ],
  derive: (next, prev, s) => {
    const physical = num(next, 'physical_memory_kb')
    const available = num(next, 'available_physical_memory_kb')
    return {
      uptime: num(next, 'uptime_s'),
      batches: rate(next, prev, s, 'batch_requests_sec'),
      tps: rate(next, prev, s, 'transactions_sec'),
      users: num(next, 'user_connections'),
      cacheHit: percentOf(
        num(next, 'buffer_cache_hit_ratio'),
        num(next, 'buffer_cache_hit_ratio_base')
      ),
      ple: num(next, 'page_life_expectancy'),
      blocked: num(next, 'processes_blocked'),
      lockWaits: rate(next, prev, s, 'lock_waits_sec'),
      compilations: rate(next, prev, s, 'sql_compilations_sec'),
      cpu: schedulerHealth(next, 'ProcessUtilization'),
      hostCpu: hostCpu(next),
      memory: percentOf(
        physical == null || available == null ? null : physical - available,
        physical
      ),
      sqlMemory: percentOf(
        num(next, 'total_server_memory_kb'),
        num(next, 'target_server_memory_kb')
      )
    }
  },
  tiles: [
    {
      key: 'batches',
      label: 'Batch requests',
      unit: 'perSec',
      hint: 'T-SQL batches received per second'
    },
    {
      key: 'tps',
      label: 'Transactions',
      unit: 'perSec',
      hint: 'Transactions started per second, all databases'
    },
    { key: 'users', label: 'User connections', unit: 'count', hint: 'Connected client sessions' },
    {
      key: 'cacheHit',
      label: 'Buffer cache hit',
      unit: 'percent',
      hint: 'Share of page reads served from the buffer cache'
    },
    {
      key: 'ple',
      label: 'Page life expectancy',
      unit: 'seconds',
      hint: 'How long a page stays in the buffer cache; low values mean memory pressure'
    },
    {
      key: 'blocked',
      label: 'Blocked processes',
      unit: 'count',
      hint: 'Sessions blocked by another session'
    },
    {
      key: 'lockWaits',
      label: 'Lock waits',
      unit: 'perSec',
      hint: 'Lock requests that had to wait, per second'
    },
    {
      key: 'compilations',
      label: 'Compilations',
      unit: 'perSec',
      hint: 'Query plan compilations per second'
    }
  ],
  meters: [
    {
      key: 'cpu',
      label: 'SQL Server CPU',
      detail: (_, point) =>
        point.hostCpu == null
          ? 'Sampled each minute'
          : `Host total ${Math.round(point.hostCpu)}% · sampled each minute`,
      warn: 70,
      danger: 90
    },
    {
      key: 'memory',
      label: 'Host memory',
      detail: (raw) =>
        usage(
          (num(raw, 'physical_memory_kb') ?? 0) - (num(raw, 'available_physical_memory_kb') ?? 0),
          num(raw, 'physical_memory_kb'),
          1024
        ),
      warn: 85,
      danger: 95
    },
    {
      key: 'sqlMemory',
      label: 'SQL Server memory',
      detail: (raw) => {
        const used = usage(
          num(raw, 'total_server_memory_kb'),
          num(raw, 'target_server_memory_kb'),
          1024
        )
        return used && `${used} target`
      }
    }
  ],
  facts: (raw) =>
    facts([
      ['Machine', raw.machine],
      ['Edition', raw.edition],
      [
        'Version',
        raw.product_version && `${raw.product_version} ${raw.product_level ?? ''}`.trim()
      ],
      [
        'Platform',
        [raw.host_distribution, raw.host_release && `(${raw.host_release})`]
          .filter(Boolean)
          .join(' ')
      ],
      ['Logical CPUs', raw.cpu_count],
      ['Physical memory', bytesFact(num(raw, 'physical_memory_kb'), 1024)],
      ['Memory state', raw.memory_state]
    ]),
  note: 'CPU, memory and most counters need the VIEW SERVER STATE permission.'
}

const BABELFISH: ServerDashboardSpec = {
  probes: [
    {
      id: 'processes',
      shape: 'row',
      sql: `SELECT COUNT(*) AS connections,
  SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running
FROM sys.sysprocesses`
    }
  ],
  derive: (next) => ({
    uptime: null,
    connections: num(next, 'connections'),
    running: num(next, 'running')
  }),
  tiles: [
    {
      key: 'connections',
      label: 'Connections',
      unit: 'count',
      hint: 'Sessions connected to the cluster'
    },
    {
      key: 'running',
      label: 'Running',
      unit: 'count',
      hint: 'Sessions currently executing a statement'
    }
  ],
  meters: [],
  facts: () => [],
  note: 'Babelfish exposes few server statistics over T-SQL. Connect to the PostgreSQL port of the same cluster for the full dashboard.'
}

const MB = 1024 * 1024
const OPS = ['insert', 'query', 'update', 'delete', 'getmore', 'command'].map(
  (k) => `opcounters.${k}`
)

const MONGO: ServerDashboardSpec = {
  probes: [
    { id: 'serverStatus', command: { serverStatus: 1 } },
    { id: 'hostInfo', command: { hostInfo: 1 }, prefix: 'host' }
  ],
  derive: (next, prev, s) => ({
    uptime: num(next, 'uptime'),
    ops: rate(next, prev, s, ...OPS),
    queries: rate(next, prev, s, 'opcounters.query', 'opcounters.getmore'),
    inserts: rate(next, prev, s, 'opcounters.insert'),
    updates: rate(next, prev, s, 'opcounters.update'),
    deletes: rate(next, prev, s, 'opcounters.delete'),
    netIn: rate(next, prev, s, 'network.bytesin'),
    netOut: rate(next, prev, s, 'network.bytesout'),
    queued: num(next, 'globallock.currentqueue.total'),
    connections: percentOf(
      num(next, 'connections.current'),
      sum(next, ['connections.current', 'connections.available'])
    ),
    memory: percentOf(num(next, 'mem.resident'), num(next, 'host.system.memsizemb')),
    cache: percentOf(
      num(next, 'wiredtiger.cache.bytes_currently_in_the_cache'),
      num(next, 'wiredtiger.cache.maximum_bytes_configured')
    )
  }),
  tiles: [
    {
      key: 'ops',
      label: 'Operations',
      unit: 'perSec',
      hint: 'All reads, writes and commands per second'
    },
    {
      key: 'queries',
      label: 'Queries',
      unit: 'perSec',
      hint: 'Queries and getMore batches per second'
    },
    { key: 'inserts', label: 'Inserts', unit: 'perSec', hint: 'Documents inserted per second' },
    { key: 'updates', label: 'Updates', unit: 'perSec', hint: 'Update operations per second' },
    { key: 'deletes', label: 'Deletes', unit: 'perSec', hint: 'Delete operations per second' },
    {
      key: 'queued',
      label: 'Queued operations',
      unit: 'count',
      hint: 'Operations waiting for a lock'
    },
    { key: 'netIn', label: 'Network in', unit: 'bytesPerSec', hint: 'Bytes received per second' },
    { key: 'netOut', label: 'Network out', unit: 'bytesPerSec', hint: 'Bytes sent per second' }
  ],
  meters: [
    {
      key: 'connections',
      label: 'Connections',
      detail: (raw) =>
        `${num(raw, 'connections.current') ?? '—'} of ${sum(raw, ['connections.current', 'connections.available']) ?? '—'}`,
      warn: 75,
      danger: 90
    },
    {
      key: 'memory',
      label: 'Resident memory',
      detail: (raw) => usage(num(raw, 'mem.resident'), num(raw, 'host.system.memsizemb'), MB),
      warn: 85,
      danger: 95
    },
    {
      key: 'cache',
      label: 'WiredTiger cache',
      detail: (raw) =>
        usage(
          num(raw, 'wiredtiger.cache.bytes_currently_in_the_cache'),
          num(raw, 'wiredtiger.cache.maximum_bytes_configured')
        ),
      warn: 95
    }
  ],
  facts: (raw) => {
    const set = raw['repl.setname']
    const primary = raw['repl.iswritableprimary'] ?? raw['repl.ismaster']
    return facts([
      ['Host', raw.host],
      ['Process', raw.process],
      [
        'Replica set',
        set
          ? `${set} · ${primary === 'true' ? 'primary' : raw['repl.secondary'] === 'true' ? 'secondary' : 'member'}`
          : 'Standalone'
      ],
      ['Storage engine', raw['storageengine.name']],
      ['Operating system', [raw['host.os.name'], raw['host.os.version']].filter(Boolean).join(' ')],
      [
        'CPU',
        raw['host.system.numcores'] &&
          `${raw['host.system.numcores']} cores · ${raw['host.system.cpuarch'] ?? ''}`
      ],
      ['Host memory', bytesFact(num(raw, 'host.system.memsizemb'), MB)],
      ['Connections created', raw['connections.totalcreated']]
    ])
  }
}

export function dashboardFor(
  engine: ConnectionConfig['engine'],
  babelfish: boolean
): ServerDashboardSpec {
  if (babelfish) return BABELFISH
  switch (engine) {
    case 'postgres':
      return POSTGRES
    case 'mysql':
      return MYSQL
    case 'mssql':
      return MSSQL
    case 'babelfish':
      return BABELFISH
    case 'mongo':
      return MONGO
    case 'sqlite':
      return SQLITE
  }
}

const SQLITE: ServerDashboardSpec = {
  probes: [
    {
      id: 'pages',
      shape: 'row',
      sql: `SELECT p.page_count * s.page_size AS size_bytes, p.page_count AS pages,
  f.freelist_count AS free_pages
FROM pragma_page_count() p, pragma_page_size() s, pragma_freelist_count() f`
    }
  ],
  derive: (next) => ({
    uptime: null,
    size_bytes: num(next, 'size_bytes'),
    pages: num(next, 'pages'),
    free_pages: num(next, 'free_pages')
  }),
  tiles: [
    {
      key: 'size_bytes',
      label: 'Database size',
      unit: 'bytes',
      hint: 'Pages in use times page size'
    },
    { key: 'pages', label: 'Pages', unit: 'count', hint: 'Total pages in the database file' },
    {
      key: 'free_pages',
      label: 'Free pages',
      unit: 'count',
      hint: 'Unused pages VACUUM would reclaim'
    }
  ],
  meters: [],
  facts: () => [],
  note: 'SQLite runs inside the client, so there are no server sessions or activity to show.'
}

export interface Collected {
  raw: Raw
  /** Probes that failed, with their error */
  errors: { probe: string; message: string }[]
}

/** Runs every probe, keeping whatever succeeds. */
export async function collect(
  connectionId: string,
  session: string,
  spec: ServerDashboardSpec
): Promise<Collected> {
  const settled = await Promise.allSettled(
    spec.probes.map(async (probe): Promise<Raw> => {
      if ('command' in probe) {
        const out = await api.mongo(connectionId, session, {
          op: 'runCommand',
          database: 'admin',
          command: probe.command
        })
        return documentToRaw(out.value, probe.prefix)
      }
      const out = await api.execute(connectionId, session, '', probe.sql, { maxRows: 500 })
      if (out.error) throw new Error(out.error.message)
      const set = out.results[out.results.length - 1]
      if (!set) return {}
      return probe.shape === 'row' ? rowToRaw(set) : pairsToRaw(set)
    })
  )
  const raw: Raw = {}
  const errors: Collected['errors'] = []
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') Object.assign(raw, r.value)
    else errors.push({ probe: spec.probes[i].id, message: errorText(r.reason) })
  })
  return { raw, errors }
}

function errorText(e: unknown): string {
  if (e instanceof Error) return e.message
  if (e && typeof e === 'object' && 'message' in e)
    return String((e as { message: unknown }).message)
  return String(e)
}

function compact(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1e9) return `${(n / 1e9).toFixed(abs >= 1e10 ? 0 : 1)}B`
  if (abs >= 1e6) return `${(n / 1e6).toFixed(abs >= 1e7 ? 0 : 1)}M`
  if (abs >= 1e3) return `${(n / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}K`
  if (Number.isInteger(n)) return String(n)
  return n.toFixed(abs < 10 ? 1 : 0)
}

export function formatUptime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s % 60}s`
  return `${s}s`
}

export function formatMetric(value: number | null | undefined, unit: Unit): string {
  if (value == null || !Number.isFinite(value)) return '—'
  switch (unit) {
    case 'count':
      return compact(value)
    case 'perSec':
      return `${compact(value)}/s`
    case 'bytes':
      return formatBytes(value)
    case 'bytesPerSec':
      return `${formatBytes(value)}/s`
    case 'percent':
      return `${value >= 99.95 || value === 0 ? Math.round(value) : value.toFixed(1)}%`
    case 'seconds':
      return value < 10 && !Number.isInteger(value) ? `${value.toFixed(1)}s` : formatUptime(value)
  }
}
