import { useCallback, useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Activity, Database, RefreshCw, ShieldCheck } from 'lucide-react'
import { api, type ConnectionConfig, type ResultSet } from '@/lib/api'
import { ENGINES } from '@/lib/engines'
import { formatBytes } from '@/lib/format'
import { queries } from '@/lib/queries'
import { dashboardFor } from '@/lib/server-metrics'
import { errorMessage } from '@/lib/toast'
import { connect, connectionsStore, statusStore, tabsStore, type TabOf } from '@/lib/workspace'
import { ResultGrid } from '@/components/grid/ResultGrid'
import { Badge, Button, EmptyState, EngineMark, ErrorText, Spinner } from '@/components/ui'
import { documentsToGrid } from '../mongo/DocumentsView'
import { LiveMetrics } from './LiveMetrics'

const ACTIVITY_SQL: Record<string, string> = {
  postgres: `SELECT pid, usename AS "user", datname AS "database", application_name AS app, client_addr AS client,
  state, now() - query_start AS running_for, wait_event_type AS waiting_on, left(query, 300) AS query
FROM pg_stat_activity
WHERE backend_type = 'client backend'
ORDER BY state = 'active' DESC, query_start`,
  mysql: `SELECT ID AS id, USER AS user, HOST AS host, DB AS db, COMMAND AS command, TIME AS seconds, STATE AS state, LEFT(INFO, 300) AS query
FROM information_schema.PROCESSLIST ORDER BY TIME DESC`,
  mssql: `SELECT s.session_id, s.login_name, DB_NAME(s.database_id) AS [database], s.program_name AS app, s.status,
  r.command, r.wait_type, r.total_elapsed_time AS elapsed_ms, LEFT(t.text, 300) AS query
FROM sys.dm_exec_sessions s
LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id
OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
WHERE s.is_user_process = 1
ORDER BY r.total_elapsed_time DESC`,
  babelfish: `SELECT * FROM sys.sysprocesses`
}

function useSqlPanel(
  connection: ConnectionConfig,
  sql: string | null
): {
  set: ResultSet | null
  error: string | null
  loading: boolean
  reload: () => void
} {
  const [set, setSet] = useState<ResultSet | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const reload = useCallback(async () => {
    if (!sql) return
    setLoading(true)
    setError(null)
    try {
      const out = await api.execute(connection.id, '__meta', '', sql)
      if (out.error) setError(out.error.message)
      else setSet(out.results[out.results.length - 1] ?? null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setLoading(false)
    }
  }, [connection.id, sql])
  useEffect(() => {
    void reload()
  }, [reload])
  return { set, error, loading, reload: () => void reload() }
}

export function ServerTab({ tab }: { tab: TabOf<'server'> }): React.JSX.Element {
  const connection = connectionsStore.use().find((c) => c.id === tab.connectionId)
  const status = statusStore.use()[tab.connectionId]
  const active = tabsStore.use().active === tab.id
  useEffect(() => {
    if (connection && status?.state !== 'connected') void connect(connection.id)
  }, [connection, status?.state])
  if (!connection) return <EmptyState title="This connection no longer exists" />
  if (status?.state !== 'connected')
    return <EmptyState title="Connecting…" icon={<Spinner className="size-5" />} />
  return <ServerDashboard connection={connection} session={tab.id} active={active} />
}

function ServerDashboard({
  connection,
  session,
  active
}: {
  connection: ConnectionConfig
  session: string
  active: boolean
}): React.JSX.Element {
  const status = statusStore.use()[connection.id]
  const info = status?.state === 'connected' ? status.info : null
  const dbs = useQuery(queries.databases(connection.id))
  const babelfish = connection.engine === 'babelfish' || !!info?.babelfishVersion
  const engineKey = babelfish ? 'babelfish' : connection.engine
  const activity = useActivity(connection, engineKey)
  const spec = dashboardFor(connection.engine, babelfish)

  return (
    <div className="h-full overflow-y-auto bg-canvas">
      <div className="mx-auto max-w-6xl space-y-6 px-6 py-6">
        <div className="flex items-center gap-4">
          <EngineMark engine={connection.engine} size="lg" />
          <div className="min-w-0">
            <h1 className="text-lg font-semibold tracking-tight text-bright">{info?.product}</h1>
            <p
              className="truncate font-mono text-[11.5px] text-muted select-text"
              title={info?.version}
            >
              {info?.version.split('\n')[0]}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-4 gap-3">
          {[
            ['Engine', ENGINES[connection.engine].label],
            ['Signed in as', info?.user || '—'],
            ['Default database', info?.currentDatabase || '—'],
            ['Databases', dbs.data ? String(dbs.data.filter((d) => !d.isSystem).length) : '…']
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg border border-line bg-panel/70 px-4 py-3">
              <p className="text-[11px] text-muted">{label}</p>
              <p className="mt-0.5 truncate text-[15px] font-medium text-bright">{value}</p>
            </div>
          ))}
        </div>

        <LiveMetrics connectionId={connection.id} session={session} spec={spec} active={active} />

        {babelfish && (
          <BabelfishPanel connection={connection} version={info?.babelfishVersion ?? null} />
        )}

        <section>
          <h2 className="mb-2 flex items-center gap-2 text-[11px] font-semibold tracking-wider text-muted uppercase">
            <Database className="size-3.5" /> Databases
          </h2>
          <div className="flex flex-wrap gap-2">
            {dbs.data?.map((d) => (
              <span
                key={d.name}
                className="flex items-center gap-2 rounded-md border border-line bg-panel/70 px-2.5 py-1 text-[12px]"
              >
                <span className={d.isSystem ? 'text-muted' : 'text-bright'}>{d.name}</span>
                {d.sizeBytes != null && (
                  <span className="text-[11px] text-faint">{formatBytes(d.sizeBytes)}</span>
                )}
              </span>
            ))}
          </div>
        </section>

        <section>
          <h2 className="mb-2 flex items-center gap-2 text-[11px] font-semibold tracking-wider text-muted uppercase">
            <Activity className="size-3.5" /> Activity
            <Button size="icon-sm" variant="ghost" onClick={activity.reload} title="Refresh">
              <RefreshCw className={activity.loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
            </Button>
          </h2>
          <div className="h-80 overflow-hidden rounded-lg border border-line">
            {activity.error ? (
              <div className="p-4">
                <ErrorText error={activity.error} />
              </div>
            ) : activity.set ? (
              <ResultGrid columns={activity.set.columns} rows={activity.set.rows} />
            ) : (
              <EmptyState title="Loading…" />
            )}
          </div>
        </section>
      </div>
    </div>
  )
}

function useActivity(
  connection: ConnectionConfig,
  engineKey: string
): ReturnType<typeof useSqlPanel> {
  const sql = connection.engine === 'mongo' ? null : ACTIVITY_SQL[engineKey]
  const sqlPanel = useSqlPanel(connection, sql)
  const [mongo, setMongo] = useState<ResultSet | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const reloadMongo = useCallback(async () => {
    if (connection.engine !== 'mongo') return
    setLoading(true)
    try {
      const out = await api.mongo(connection.id, '__meta', {
        op: 'aggregate',
        database: 'admin',
        collection: '',
        pipeline: [
          { $currentOp: { allUsers: true, idleConnections: false } },
          {
            $project: {
              opid: 1,
              active: 1,
              op: 1,
              ns: 1,
              secs_running: 1,
              client: 1,
              appName: 1,
              command: 1
            }
          }
        ]
      })
      setMongo({
        ...documentsToGrid(out.documents),
        rowCount: out.documents.length,
        truncated: false
      })
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setLoading(false)
    }
  }, [connection.engine, connection.id])
  useEffect(() => {
    void reloadMongo()
  }, [reloadMongo])
  if (connection.engine === 'mongo')
    return { set: mongo, error, loading, reload: () => void reloadMongo() }
  return sqlPanel
}

function BabelfishPanel({
  connection,
  version
}: {
  connection: ConnectionConfig
  version: string | null
}): React.JSX.Element {
  const hatches = useSqlPanel(connection, 'EXEC sp_babelfish_configure')
  return (
    <section className="rounded-lg border border-babelfish/25 bg-babelfish/[0.04] p-4">
      <div className="mb-3 flex items-center gap-2">
        <ShieldCheck className="size-4 text-babelfish" />
        <h2 className="font-medium text-bright">Babelfish</h2>
        {version && <Badge className="bg-babelfish/15 text-babelfish">{version}</Badge>}
        <span className="text-xs text-muted">T-SQL running on Aurora PostgreSQL</span>
      </div>
      <p className="mb-3 text-xs leading-relaxed text-muted">
        Escape hatches control how Babelfish treats T-SQL it doesn&apos;t support:{' '}
        <span className="font-mono text-fg">strict</span> raises an error,{' '}
        <span className="font-mono text-fg">ignore</span> skips the unsupported clause. Change one
        with{' '}
        <span className="font-mono text-fg">
          EXEC sp_babelfish_configure &apos;escape_hatch_name&apos;, &apos;ignore&apos;
        </span>
        .
      </p>
      <div className="h-64 overflow-hidden rounded-md border border-line">
        {hatches.error ? (
          <div className="p-4">
            <ErrorText error={hatches.error} />
          </div>
        ) : hatches.set ? (
          <ResultGrid columns={hatches.set.columns} rows={hatches.set.rows} />
        ) : (
          <EmptyState title="Loading escape hatches…" />
        )}
      </div>
    </section>
  )
}
