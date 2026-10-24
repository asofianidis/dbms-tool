/**
 * The server tab's slow-query and lock lists. Keys match the activity queries:
 * an engine, or `babelfish` for Babelfish's TDS endpoint.
 */

export type SlowQueryOrder = 'total' | 'mean' | 'calls'

/** Where SQL Server's statement statistics come from. */
export type MssqlSource = { kind: 'plan-cache' } | { kind: 'query-store'; database: string }

const LIMIT = 50

function bracket(name: string): string {
  return `[${name.replace(/]/g, ']]')}]`
}

/**
 * Top statements by total time, mean time or executions. PostgreSQL reads
 * pg_stat_statements (`legacy` for the pre-13 column names), MySQL the
 * performance_schema digest summary, SQL Server the plan cache or a database's Query Store.
 */
export function slowQuerySql(
  engineKey: string,
  order: SlowQueryOrder,
  options: { legacy?: boolean; source?: MssqlSource } = {}
): string | null {
  switch (engineKey) {
    case 'postgres': {
      const total = options.legacy ? 'total_time' : 'total_exec_time'
      const mean = options.legacy ? 'mean_time' : 'mean_exec_time'
      const max = options.legacy ? 'max_time' : 'max_exec_time'
      const by = { total, mean, calls: 'calls' }[order]
      return `SELECT queryid::text AS query_id, calls,
  round(${total}::numeric, 1) AS total_ms, round(${mean}::numeric, 2) AS mean_ms,
  round(${max}::numeric, 1) AS max_ms, rows,
  round(100.0 * shared_blks_hit / nullif(shared_blks_hit + shared_blks_read, 0), 1) AS cache_hit_pct,
  temp_blks_written, r.rolname AS "user", d.datname AS "database", left(query, 500) AS query
FROM pg_stat_statements s
LEFT JOIN pg_roles r ON r.oid = s.userid
LEFT JOIN pg_database d ON d.oid = s.dbid
ORDER BY ${by} DESC NULLS LAST
LIMIT ${LIMIT}`
    }
    case 'mysql': {
      const by = { total: 'SUM_TIMER_WAIT', mean: 'AVG_TIMER_WAIT', calls: 'COUNT_STAR' }[order]
      // Timers are in picoseconds
      return `SELECT SCHEMA_NAME AS db, COUNT_STAR AS calls,
  ROUND(SUM_TIMER_WAIT / 1e9, 1) AS total_ms, ROUND(AVG_TIMER_WAIT / 1e9, 2) AS mean_ms,
  ROUND(MAX_TIMER_WAIT / 1e9, 1) AS max_ms, SUM_ROWS_EXAMINED AS rows_examined,
  SUM_ROWS_SENT AS rows_sent, SUM_NO_INDEX_USED AS no_index_used,
  SUM_CREATED_TMP_DISK_TABLES AS tmp_disk_tables, LAST_SEEN AS last_seen,
  LEFT(DIGEST_TEXT, 500) AS query
FROM performance_schema.events_statements_summary_by_digest
WHERE DIGEST_TEXT IS NOT NULL
ORDER BY ${by} DESC
LIMIT ${LIMIT}`
    }
    case 'mssql': {
      const source = options.source ?? { kind: 'plan-cache' }
      if (source.kind === 'query-store') {
        const db = bracket(source.database)
        const by = { total: 'total_ms', mean: 'mean_ms', calls: 'calls' }[order]
        // Durations are in microseconds
        return `SELECT TOP (${LIMIT}) q.query_id, SUM(rs.count_executions) AS calls,
  CAST(SUM(rs.avg_duration * rs.count_executions) / 1000.0 AS decimal(18, 1)) AS total_ms,
  CAST(SUM(rs.avg_duration * rs.count_executions) / NULLIF(SUM(rs.count_executions), 0) / 1000.0 AS decimal(18, 2)) AS mean_ms,
  CAST(MAX(rs.max_duration) / 1000.0 AS decimal(18, 1)) AS max_ms,
  CAST(SUM(rs.avg_cpu_time * rs.count_executions) / 1000.0 AS decimal(18, 1)) AS cpu_ms,
  SUM(rs.avg_logical_io_reads * rs.count_executions) AS logical_reads,
  COUNT(DISTINCT p.plan_id) AS plans, MAX(rs.last_execution_time) AS last_run,
  LEFT(MAX(qt.query_sql_text), 500) AS query
FROM ${db}.sys.query_store_query q
JOIN ${db}.sys.query_store_query_text qt ON qt.query_text_id = q.query_text_id
JOIN ${db}.sys.query_store_plan p ON p.query_id = q.query_id
JOIN ${db}.sys.query_store_runtime_stats rs ON rs.plan_id = p.plan_id
GROUP BY q.query_id
ORDER BY ${by} DESC`
      }
      const by = {
        total: 'qs.total_elapsed_time',
        mean: 'qs.total_elapsed_time / qs.execution_count',
        calls: 'qs.execution_count'
      }[order]
      return `SELECT TOP (${LIMIT}) DB_NAME(t.dbid) AS [database], qs.execution_count AS calls,
  CAST(qs.total_elapsed_time / 1000.0 AS decimal(18, 1)) AS total_ms,
  CAST(qs.total_elapsed_time / 1000.0 / qs.execution_count AS decimal(18, 2)) AS mean_ms,
  CAST(qs.max_elapsed_time / 1000.0 AS decimal(18, 1)) AS max_ms,
  CAST(qs.total_worker_time / 1000.0 AS decimal(18, 1)) AS cpu_ms,
  qs.total_logical_reads AS logical_reads, qs.total_rows AS rows,
  qs.last_execution_time AS last_run,
  LEFT(SUBSTRING(t.text, qs.statement_start_offset / 2 + 1,
    (CASE qs.statement_end_offset WHEN -1 THEN DATALENGTH(t.text) ELSE qs.statement_end_offset END
      - qs.statement_start_offset) / 2 + 1), 500) AS query
FROM sys.dm_exec_query_stats qs
CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) t
ORDER BY ${by} DESC`
    }
    default:
      return null
  }
}

/** SQL Server databases with Query Store turned on. */
export const QUERY_STORE_DATABASES_SQL =
  'SELECT name FROM sys.databases WHERE is_query_store_on = 1 ORDER BY name'

/** What to tell the user when the slow-query source isn't set up. */
export function slowQuerySetupHint(engineKey: string, error: string): string | null {
  if (engineKey === 'postgres' && /pg_stat_statements/.test(error))
    return /must be loaded via/i.test(error)
      ? 'Add pg_stat_statements to shared_preload_libraries in postgresql.conf and restart the server.'
      : 'Run CREATE EXTENSION pg_stat_statements; in this database. The module must also be listed in shared_preload_libraries.'
  if (engineKey === 'mysql' && /performance_schema/i.test(error))
    return 'Turn on performance_schema (performance_schema = ON in my.cnf) and restart the server.'
  if (engineKey === 'mssql' && /VIEW SERVER STATE|permission/i.test(error))
    return 'Reading statement statistics needs the VIEW SERVER STATE permission (VIEW DATABASE STATE for Query Store).'
  return null
}

/** Whether a PostgreSQL error means pg_stat_statements predates the version 13 column names. */
export function isLegacyPgStatStatements(error: string): boolean {
  return /total_exec_time|mean_exec_time|max_exec_time/.test(error) && /does not exist/.test(error)
}

/** Lock list per engine; MySQL needs 8.0 for performance_schema.data_locks. */
export const LOCKS_SQL: Record<string, string> = {
  postgres: `SELECT l.pid, a.usename AS "user", l.locktype, l.mode, l.granted,
  COALESCE(l.relation::regclass::text, l.transactionid::text, l.virtualxid,
    CASE WHEN l.locktype = 'advisory' THEN l.classid::text || ':' || l.objid::text END) AS target,
  array_to_string(pg_blocking_pids(l.pid), ', ') AS blocked_by, a.state,
  now() - a.xact_start AS transaction_age, left(a.query, 300) AS query
FROM pg_locks l
LEFT JOIN pg_stat_activity a ON a.pid = l.pid
WHERE l.pid <> pg_backend_pid()
  AND (NOT l.granted OR l.locktype IN ('relation', 'transactionid', 'tuple', 'advisory', 'object'))
  AND (l.database IS NULL OR l.database = (SELECT oid FROM pg_database WHERE datname = current_database()))
ORDER BY l.granted, l.pid`,
  mysql: `SELECT t.PROCESSLIST_ID AS id, dl.OBJECT_SCHEMA AS db, dl.OBJECT_NAME AS table_name,
  dl.INDEX_NAME AS index_name, dl.LOCK_TYPE AS lock_type, dl.LOCK_MODE AS mode,
  dl.LOCK_STATUS AS status, dl.LOCK_DATA AS lock_data,
  (SELECT GROUP_CONCAT(DISTINCT bt.PROCESSLIST_ID)
     FROM performance_schema.data_lock_waits w
     JOIN performance_schema.threads bt ON bt.THREAD_ID = w.BLOCKING_THREAD_ID
    WHERE w.REQUESTING_ENGINE_LOCK_ID = dl.ENGINE_LOCK_ID) AS blocked_by
FROM performance_schema.data_locks dl
LEFT JOIN performance_schema.threads t ON t.THREAD_ID = dl.THREAD_ID
ORDER BY dl.LOCK_STATUS = 'WAITING' DESC, t.PROCESSLIST_ID`,
  mssql: `SELECT l.request_session_id AS session_id, DB_NAME(l.resource_database_id) AS [database],
  l.resource_type,
  CASE WHEN l.resource_type = 'OBJECT'
    THEN OBJECT_SCHEMA_NAME(l.resource_associated_entity_id, l.resource_database_id) + '.' +
      OBJECT_NAME(l.resource_associated_entity_id, l.resource_database_id) END AS object_name,
  RTRIM(l.resource_description) AS resource, l.request_mode AS mode, l.request_status AS status,
  NULLIF(w.blocking_session_id, 0) AS blocked_by, w.wait_duration_ms
FROM sys.dm_tran_locks l
LEFT JOIN sys.dm_os_waiting_tasks w ON w.resource_address = l.lock_owner_address
WHERE l.request_session_id <> @@SPID AND l.resource_type <> 'DATABASE'
ORDER BY CASE l.request_status WHEN 'WAIT' THEN 0 ELSE 1 END, l.request_session_id`
}

/** Lock-list columns naming the session and the sessions it waits on, for the blocking tree. */
export const LOCK_COLUMNS: Record<string, { id: string; blockedBy: string }> = {
  postgres: { id: 'pid', blockedBy: 'blocked_by' },
  mysql: { id: 'id', blockedBy: 'blocked_by' },
  mssql: { id: 'session_id', blockedBy: 'blocked_by' }
}

/** MongoDB operations holding or waiting for locks. */
export const MONGO_LOCKS_PIPELINE = [
  { $currentOp: { allUsers: true, idleConnections: false } },
  { $match: { $or: [{ waitingForLock: true }, { 'locks.Global': { $exists: true } }] } },
  {
    $project: {
      opid: 1,
      op: 1,
      ns: 1,
      waitingForLock: 1,
      secs_running: 1,
      locks: 1,
      desc: 1
    }
  },
  { $sort: { waitingForLock: -1, secs_running: -1 } }
]

export const REFRESH_INTERVALS = [0, 2, 5, 10, 30] as const
export type RefreshInterval = (typeof REFRESH_INTERVALS)[number]
