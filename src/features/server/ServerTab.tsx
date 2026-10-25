import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Activity, Database, OctagonX, RefreshCw, ShieldCheck, Snail, Square } from 'lucide-react'
import { api, type Cell, type ConnectionConfig, type ResultSet } from '@/lib/api'
import { withAuroraMetrics } from '@/lib/aurora'
import { ENGINES } from '@/lib/engines'
import { extensionFlavor } from '@/lib/extensions'
import { formatBytes } from '@/lib/format'
import { withGaleraMetrics } from '@/lib/galera'
import { isMariaDb } from '@/lib/mariadb'
import { queries } from '@/lib/queries'
import { parseClientList, parseSlowlog, recordsToSet, dataText } from '@/lib/redis'
import { dashboardFor } from '@/lib/server-metrics'
import { LOCK_COLUMNS, type RefreshInterval } from '@/lib/server-perf'
import {
  BLOCKED_BY_COLUMN,
  blockedCount,
  blockingEdges,
  blockingIds,
  blockingTree,
  mongoOpId,
  sessionActionSql,
  sessionActions,
  SESSION_ID_COLUMN,
  type SessionAction
} from '@/lib/sessions'
import { errorMessage, toast, toastError } from '@/lib/toast'
import {
  confirm,
  connect,
  connectionsStore,
  statusStore,
  tabsStore,
  type TabOf
} from '@/lib/workspace'
import type { MenuItem } from '@/components/ContextMenu'
import { ResultGrid } from '@/components/grid/ResultGrid'
import { Badge, Button, EmptyState, EngineMark, ErrorText, Spinner } from '@/components/ui'
import { ClusterPanel } from '../mongo/ClusterPanel'
import { AuroraPanel, useAurora } from './AuroraPanel'
import { ExtensionsPanel } from './ExtensionsPanel'
import { GaleraPanel, useGalera } from './GaleraPanel'
import { PgReplicationPanel, usePgReplication } from './PgReplicationPanel'
import { documentsToGrid } from '../mongo/DocumentsView'
import { LiveMetrics, useDocumentVisible } from './LiveMetrics'
import {
  BlockingTree,
  LocksSection,
  RefreshSelect,
  SlowQueriesSection,
  useLocks
} from './PerformancePanels'
import { PgHealthSection } from './PgHealthPanels'
import { ReplicationPanel } from './ReplicationPanel'
import { SlowLogPanel } from './SlowLogPanel'
import { PgSettingsPanel } from './PgSettingsPanel'
import { useSqlPanel, type SqlPanel } from './useSqlPanel'

const ACTIVITY_SQL: Record<string, string> = {
  postgres: `SELECT pid, usename AS "user", datname AS "database", application_name AS app, client_addr AS client,
  state, array_to_string(pg_blocking_pids(pid), ', ') AS blocked_by,
  now() - query_start AS running_for, wait_event_type AS waiting_on, left(query, 300) AS query
FROM pg_stat_activity
WHERE backend_type = 'client backend'
ORDER BY state = 'active' DESC, query_start`,
  mysql: `SELECT ID AS id, USER AS user, HOST AS host, DB AS db, COMMAND AS command, TIME AS seconds, STATE AS state, LEFT(INFO, 300) AS query
FROM information_schema.PROCESSLIST ORDER BY TIME DESC`,
  mssql: `SELECT s.session_id, s.login_name, DB_NAME(s.database_id) AS [database], s.program_name AS app, s.status,
  NULLIF(r.blocking_session_id, 0) AS blocked_by, r.command, r.wait_type, r.total_elapsed_time AS elapsed_ms,
  LEFT(t.text, 300) AS query
FROM sys.dm_exec_sessions s
LEFT JOIN sys.dm_exec_requests r ON r.session_id = s.session_id
OUTER APPLY sys.dm_exec_sql_text(r.sql_handle) t
WHERE s.is_user_process = 1
ORDER BY r.total_elapsed_time DESC`,
  babelfish: `SELECT * FROM sys.sysprocesses`
}

const CLIENT_COLUMNS = [
  'id',
  'addr',
  'name',
  'db',
  'cmd',
  'age',
  'idle',
  'flags',
  'lib-name',
  'user'
]

/** A Redis command whose reply becomes a grid, e.g. CLIENT LIST. */
function useRedisPanel(
  connection: ConnectionConfig,
  args: string[] | null,
  toSet: (out: Awaited<ReturnType<typeof api.redis>>) => ResultSet
): SqlPanel {
  const [set, setSet] = useState<ResultSet | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const key = args?.join(' ')
  const reload = useCallback(async () => {
    if (!key) return
    setLoading(true)
    try {
      const out = await api.redis(connection.id, '__meta', {
        op: 'command',
        database: '0',
        args: key.split(' ')
      })
      if (out.reply?.t === 'error') throw new Error(out.reply.v)
      setSet(toSet(out))
      setError(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.id, key])
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
  const actions = sessionActions(engineKey)
  const blocked = activity.set
    ? blockedCount(engineKey, activity.set.columns, activity.set.rows)
    : 0
  const blockers = activity.set
    ? [...blockingIds(engineKey, activity.set.columns, activity.set.rows)]
    : []
  const locks = useLocks(connection, engineKey)
  const [refresh, setRefresh] = useState<RefreshInterval>(5)
  const visible = useDocumentVisible()
  const galera = useGalera(connection, isMariaDb(info), active && visible ? refresh : 0)
  const extensions = extensionFlavor(connection.engine, info)
  const replication = usePgReplication(
    connection,
    connection.engine === 'postgres' && !babelfish,
    active && visible ? refresh : 0
  )
  const aurora = useAurora(
    connection,
    connection.engine === 'postgres' && !babelfish,
    active && visible ? refresh : 0
  )

  // Blocking chains from the activity list's blocked-by column and the lock list's
  const forest = useMemo(() => {
    const edges: [string, string][] = []
    const blockedBy = BLOCKED_BY_COLUMN[engineKey]
    if (activity.set && blockedBy)
      edges.push(
        ...blockingEdges(
          activity.set.columns,
          activity.set.rows,
          SESSION_ID_COLUMN[engineKey],
          blockedBy
        )
      )
    const lockCols = LOCK_COLUMNS[engineKey]
    if (locks?.set && lockCols)
      edges.push(
        ...blockingEdges(locks.set.columns, locks.set.rows, lockCols.id, lockCols.blockedBy)
      )
    return blockingTree(edges)
  }, [activity.set, locks?.set, engineKey])

  // Auto-refresh runs only while the tab is in front and the window is visible
  const reloads = useRef<() => void>(() => {})
  reloads.current = () => {
    activity.reload()
    locks?.reload()
  }
  // A tick that finds the last refresh still running is skipped
  const busy = useRef(false)
  busy.current = activity.loading || !!locks?.loading
  useEffect(() => {
    if (!refresh || !active || !visible) return
    const timer = setInterval(() => {
      if (!busy.current) reloads.current()
    }, refresh * 1000)
    return () => clearInterval(timer)
  }, [refresh, active, visible])

  const act = async (action: SessionAction, id: Cell): Promise<void> => {
    const what =
      engineKey === 'mongo'
        ? `operation ${id}`
        : engineKey === 'redis'
          ? `client ${id}`
          : `session ${id}`
    const ok = await confirm({
      title: action === 'cancel' ? `Cancel the query in ${what}?` : `Kill ${what}?`,
      message:
        action === 'cancel'
          ? 'The running statement stops with an error; the session stays connected.'
          : engineKey === 'mongo'
            ? 'The operation is interrupted. Writes it already made stay.'
            : engineKey === 'redis'
              ? 'The client is disconnected; a queued MULTI transaction is discarded.'
              : 'The session is disconnected and its open transaction is rolled back.',
      confirmLabel: action === 'cancel' ? 'Cancel query' : 'Kill',
      danger: true
    })
    if (!ok) return
    try {
      if (engineKey === 'redis') {
        if (typeof id !== 'string') return
        await api.redis(connection.id, '__meta', {
          op: 'command',
          database: '0',
          args: ['CLIENT', 'KILL', 'ID', id]
        })
      } else if (engineKey === 'mongo') {
        const op = mongoOpId(id)
        if (op === null) return
        await api.mongo(connection.id, '__meta', {
          op: 'runCommand',
          database: 'admin',
          command: { killOp: 1, op }
        })
      } else {
        const sql = sessionActionSql(engineKey, action, id)
        if (!sql) return
        const out = await api.execute(connection.id, '__meta', '', sql)
        if (out.error) throw new Error(out.error.message)
        // pg_cancel_backend / pg_terminate_backend return false for a session that's gone
        if (out.results[0]?.rows[0]?.[0] === false) {
          toast(`Session ${id} had already ended`)
          activity.reload()
          return
        }
      }
      toast(action === 'cancel' ? `Cancelled the query in ${what}` : `Killed ${what}`)
    } catch (e) {
      toastError(e)
    }
    reloads.current()
  }

  const activityMenu = (row: number): MenuItem[] => {
    const set = activity.set
    const col = set?.columns.findIndex((c) => c.name === SESSION_ID_COLUMN[engineKey]) ?? -1
    if (!set || col < 0 || !actions.length) return []
    const id = set.rows[row]?.[col] ?? null
    if (id === null) return []
    return [
      'separator',
      ...actions.map((action): MenuItem => ({
        label:
          action === 'cancel'
            ? 'Cancel query'
            : engineKey === 'mongo'
              ? 'Kill operation'
              : engineKey === 'redis'
                ? 'Kill client'
                : 'Kill session',
        icon: action === 'cancel' ? <Square /> : <OctagonX />,
        danger: action === 'kill',
        onSelect: () => void act(action, id)
      }))
    ]
  }

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

        <LiveMetrics
          connectionId={connection.id}
          session={session}
          spec={
            galera.status
              ? withGaleraMetrics(spec)
              : aurora.status?.instances
                ? withAuroraMetrics(spec)
                : spec
          }
          active={active}
        />

        <GaleraPanel galera={galera} />

        <PgReplicationPanel connection={connection} replication={replication} />

        <AuroraPanel aurora={aurora} />

        {babelfish && (
          <BabelfishPanel connection={connection} version={info?.babelfishVersion ?? null} />
        )}

        {connection.engine === 'mongo' && <ClusterPanel connection={connection} />}

        <section>
          <h2 className="mb-2 flex items-center gap-2 text-[11px] font-semibold tracking-wider text-muted uppercase">
            <Database className="size-3.5" /> Databases
          </h2>
          <div className="flex flex-wrap gap-2">
            {dbs.data
              // Redis lists 16 numbered keyspaces; the empty ones are noise
              ?.filter(
                (d) => d.keys === undefined || d.keys > 0 || d.name === info?.currentDatabase
              )
              .map((d) => (
                <span
                  key={d.name}
                  className="flex items-center gap-2 rounded-md border border-line bg-panel/70 px-2.5 py-1 text-[12px]"
                >
                  <span className={d.isSystem ? 'text-muted' : 'text-bright'}>
                    {d.keys !== undefined ? `db${d.name}` : d.name}
                  </span>
                  {d.sizeBytes != null && (
                    <span className="text-[11px] text-faint">{formatBytes(d.sizeBytes)}</span>
                  )}
                  {d.keys !== undefined && (
                    <span className="text-[11px] text-faint">{d.keys.toLocaleString()} keys</span>
                  )}
                </span>
              ))}
          </div>
        </section>

        <section>
          <h2 className="mb-2 flex items-center gap-2 text-[11px] font-semibold tracking-wider text-muted uppercase">
            <Activity className="size-3.5" /> Activity
            <Button size="icon-sm" variant="ghost" onClick={reloads.current} title="Refresh">
              <RefreshCw className={activity.loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
            </Button>
            {engineKey !== 'sqlite' && <RefreshSelect value={refresh} onChange={setRefresh} />}
            {blocked > 0 && (
              <Badge
                tone="danger"
                className="normal-case"
                title="Sessions waiting on a lock another session holds"
              >
                {blocked} blocked{blockers.length > 0 && ` by ${blockers.join(', ')}`}
              </Badge>
            )}
            <span className="ml-auto flex items-center gap-2 text-[11px] font-normal tracking-normal normal-case">
              {actions.length > 0 && (
                <span className="text-faint">
                  Right-click a row to {actions.includes('cancel') ? 'cancel its query or ' : ''}
                  kill it
                </span>
              )}
            </span>
          </h2>
          <div className="h-80 overflow-hidden rounded-lg border border-line">
            {activity.error ? (
              <div className="p-4">
                <ErrorText error={activity.error} />
              </div>
            ) : activity.set ? (
              <ResultGrid
                columns={activity.set.columns}
                rows={activity.set.rows}
                cellMenuItems={activityMenu}
              />
            ) : (
              <EmptyState title="Loading…" />
            )}
          </div>
        </section>

        {connection.engine === 'redis' && <SlowLog connection={connection} />}

        {forest.length > 0 && (
          <BlockingTree
            forest={forest}
            engineKey={engineKey}
            activity={activity.set}
            onKill={actions.includes('kill') ? (id) => void act('kill', id) : undefined}
          />
        )}

        {locks && <LocksSection locks={locks} engineKey={engineKey} />}

        {connection.engine === 'mysql' && (
          <ReplicationPanel
            connection={connection}
            info={info}
            refresh={refresh}
            active={active && visible}
          />
        )}

        <SlowQueriesSection
          connection={connection}
          engineKey={engineKey}
          databases={dbs.data?.filter((d) => !d.isSystem).map((d) => d.name) ?? []}
        />

        {connection.engine === 'mysql' && <SlowLogPanel connection={connection} />}

        {extensions && (
          <ExtensionsPanel
            // A different flavor (MariaDB detected after connecting) starts with fresh state
            key={extensions}
            connection={connection}
            flavor={extensions}
            databases={dbs.data?.filter((d) => !d.isSystem).map((d) => d.name) ?? []}
            defaultDatabase={info?.currentDatabase ?? ''}
          />
        )}

        {engineKey === 'postgres' && (
          <PgHealthSection
            connection={connection}
            databases={dbs.data?.filter((d) => !d.isSystem).map((d) => d.name) ?? []}
            defaultDatabase={info?.currentDatabase ?? ''}
            active={active && visible}
            onSessionAction={act}
          />
        )}

        {connection.engine === 'postgres' && !babelfish && (
          <PgSettingsPanel connection={connection} />
        )}
      </div>
    </div>
  )
}

function SlowLog({ connection }: { connection: ConnectionConfig }): React.JSX.Element {
  const panel = useRedisPanel(connection, ['SLOWLOG', 'GET', '100'], (out) =>
    recordsToSet(parseSlowlog(out.reply), ['id', 'at', 'duration_ms', 'command', 'client', 'name'])
  )
  return (
    <section>
      <h2 className="mb-2 flex items-center gap-2 text-[11px] font-semibold tracking-wider text-muted uppercase">
        <Snail className="size-3.5" /> Slow log
        <Button size="icon-sm" variant="ghost" onClick={panel.reload} title="Refresh">
          <RefreshCw className={panel.loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
        </Button>
        <span className="ml-auto text-[11px] font-normal tracking-normal text-faint normal-case">
          Commands slower than slowlog-log-slower-than, newest first
        </span>
      </h2>
      <div className="h-64 overflow-hidden rounded-lg border border-line">
        {panel.error ? (
          <div className="p-4">
            <ErrorText error={panel.error} />
          </div>
        ) : panel.set ? (
          panel.set.rows.length ? (
            <ResultGrid columns={panel.set.columns} rows={panel.set.rows} />
          ) : (
            <EmptyState title="No slow commands logged" />
          )
        ) : (
          <EmptyState title="Loading…" />
        )}
      </div>
    </section>
  )
}

function useActivity(
  connection: ConnectionConfig,
  engineKey: string
): ReturnType<typeof useSqlPanel> {
  // SQLite runs in-process, so there are no sessions to list
  const sql =
    connection.engine === 'mongo' || connection.engine === 'sqlite' || connection.engine === 'redis'
      ? null
      : ACTIVITY_SQL[engineKey]
  const sqlPanel = useSqlPanel(connection, sql)
  const redisPanel = useRedisPanel(
    connection,
    connection.engine === 'redis' ? ['CLIENT', 'LIST'] : null,
    (out) =>
      recordsToSet(
        parseClientList(out.reply?.t === 'bulk' ? dataText(out.reply.v) : ''),
        CLIENT_COLUMNS
      )
  )
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
  if (connection.engine === 'redis') return redisPanel
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
