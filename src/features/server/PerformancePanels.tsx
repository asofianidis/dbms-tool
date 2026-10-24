import { useCallback, useEffect, useMemo, useState } from 'react'
import { Code2, Gauge, GitFork, Lock, OctagonX, RefreshCw } from 'lucide-react'
import { api, type Cell, type ConnectionConfig, type ResultSet } from '@/lib/api'
import { cn } from '@/lib/cn'
import { scalarText } from '@/lib/ejson'
import { shellCollection } from '@/lib/mongo-shell'
import {
  isLegacyPgStatStatements,
  LOCKS_SQL,
  MONGO_LOCKS_PIPELINE,
  QUERY_STORE_DATABASES_SQL,
  REFRESH_INTERVALS,
  slowQuerySetupHint,
  slowQuerySql,
  type MssqlSource,
  type RefreshInterval,
  type SlowQueryOrder
} from '@/lib/server-perf'
import { SESSION_ID_COLUMN, type BlockingNode } from '@/lib/sessions'
import { errorMessage, toast, toastError } from '@/lib/toast'
import { newQueryTab } from '@/lib/workspace'
import type { MenuItem } from '@/components/ContextMenu'
import { ResultGrid } from '@/components/grid/ResultGrid'
import { Badge, Button, EmptyState, ErrorText, Input, Segmented, Select } from '@/components/ui'
import { documentsToGrid } from '../mongo/DocumentsView'
import { useSqlPanel, type SqlPanel } from './useSqlPanel'

export function SectionHeading({
  icon,
  title,
  children
}: {
  icon: React.ReactNode
  title: string
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <h2 className="mb-2 flex items-center gap-2 text-[11px] font-semibold tracking-wider text-muted uppercase">
      {icon} {title}
      {children}
    </h2>
  )
}

function GridBox({
  panel,
  empty,
  menu,
  height = 'h-80',
  hint
}: {
  panel: SqlPanel
  empty: string
  menu?: (row: number) => MenuItem[]
  height?: string
  hint?: string | null
}): React.JSX.Element {
  return (
    <div className={cn(height, 'overflow-hidden rounded-lg border border-line')}>
      {panel.error ? (
        <div className="space-y-2 p-4">
          <ErrorText error={panel.error} />
          {hint && <p className="text-xs text-muted">{hint}</p>}
        </div>
      ) : panel.set ? (
        panel.set.rows.length ? (
          <ResultGrid columns={panel.set.columns} rows={panel.set.rows} cellMenuItems={menu} />
        ) : (
          <EmptyState title={empty} />
        )
      ) : (
        <EmptyState title="Loading…" />
      )}
    </div>
  )
}

export function RefreshSelect({
  value,
  onChange
}: {
  value: RefreshInterval
  onChange: (v: RefreshInterval) => void
}): React.JSX.Element {
  return (
    <Select
      value={value}
      onChange={(e) => onChange(Number(e.target.value) as RefreshInterval)}
      title="Refresh activity, blocking and locks automatically while this tab is open"
      className="w-36 font-normal tracking-normal normal-case"
      selectClassName="h-6 text-[11.5px]"
    >
      {REFRESH_INTERVALS.map((s) => (
        <option key={s} value={s}>
          {s ? `Every ${s} s` : 'Auto-refresh off'}
        </option>
      ))}
    </Select>
  )
}

/* ---------- Locks ---------- */

/** The engine's lock list, or null where there isn't one (SQLite, Babelfish). */
export function useLocks(connection: ConnectionConfig, engineKey: string): SqlPanel | null {
  const sql = LOCKS_SQL[engineKey] ?? null
  const sqlPanel = useSqlPanel(connection, sql)
  const mongo = useMongoPanel(connection, engineKey === 'mongo', 'admin', '', MONGO_LOCKS_PIPELINE)
  if (engineKey === 'mongo') return mongo
  return sql ? sqlPanel : null
}

/** Runs an aggregation on the metadata session, shaped like a SQL panel. */
function useMongoPanel(
  connection: ConnectionConfig,
  enabled: boolean,
  database: string,
  collection: string,
  pipeline: unknown[]
): SqlPanel {
  const [set, setSet] = useState<ResultSet | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const key = JSON.stringify(pipeline)
  const reload = useCallback(async () => {
    if (!enabled) return
    setLoading(true)
    try {
      const out = await api.mongo(connection.id, '__meta', {
        op: 'aggregate',
        database,
        collection,
        pipeline: JSON.parse(key) as unknown[]
      })
      setSet({
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
  }, [connection.id, enabled, database, collection, key])
  useEffect(() => {
    void reload()
  }, [reload])
  return { set, error, loading, reload: () => void reload() }
}

export function LocksSection({
  locks,
  engineKey
}: {
  locks: SqlPanel
  engineKey: string
}): React.JSX.Element {
  const waiting = useMemo(() => {
    const set = locks.set
    if (!set) return 0
    const col = set.columns.findIndex((c) =>
      ['granted', 'status', 'waitingForLock'].includes(c.name)
    )
    if (col < 0) return 0
    return set.rows.filter((r) => ['false', 'WAITING', 'WAIT', 'true'].includes(String(r[col])))
      .length
  }, [locks.set])
  return (
    <section>
      <SectionHeading icon={<Lock className="size-3.5" />} title="Locks">
        <Button size="icon-sm" variant="ghost" onClick={locks.reload} title="Refresh">
          <RefreshCw className={locks.loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
        </Button>
        {waiting > 0 && (
          <Badge tone="warning" className="normal-case">
            {waiting} waiting
          </Badge>
        )}
        <span className="ml-auto text-[11px] font-normal tracking-normal text-faint normal-case">
          {engineKey === 'mongo'
            ? 'Operations holding or waiting for locks'
            : engineKey === 'mysql'
              ? 'InnoDB row and table locks (MySQL 8.0+)'
              : 'Waiting locks first'}
        </span>
      </SectionHeading>
      <GridBox
        panel={locks}
        empty="No locks held by other sessions"
        height="h-64"
        hint={
          engineKey === 'mysql' && locks.error && /data_locks/.test(locks.error)
            ? 'performance_schema.data_locks needs MySQL 8.0 or later with performance_schema on.'
            : null
        }
      />
    </section>
  )
}

/* ---------- Blocking chains ---------- */

const SUMMARY_COLUMNS = {
  user: ['user', 'login_name', 'loginame'],
  state: ['state', 'status', 'command', 'cmd'],
  wait: ['waiting_on', 'wait_type', 'lastwaittype'],
  time: ['running_for', 'elapsed_ms', 'seconds', 'waittime'],
  query: ['query']
}

function summarize(
  engineKey: string,
  set: ResultSet | null,
  id: string
): Partial<Record<keyof typeof SUMMARY_COLUMNS, string>> {
  if (!set) return {}
  const idCol = set.columns.findIndex((c) => c.name === SESSION_ID_COLUMN[engineKey])
  const row = set.rows.find((r) => r[idCol] === id)
  if (!row) return {}
  const out: Partial<Record<keyof typeof SUMMARY_COLUMNS, string>> = {}
  for (const [key, names] of Object.entries(SUMMARY_COLUMNS)) {
    const col = set.columns.findIndex((c) => names.includes(c.name))
    const v = col >= 0 ? row[col] : null
    if (v !== null && v !== undefined && String(v).trim())
      out[key as keyof typeof SUMMARY_COLUMNS] = String(v).trim()
  }
  return out
}

export function BlockingTree({
  forest,
  engineKey,
  activity,
  onKill
}: {
  forest: BlockingNode[]
  engineKey: string
  activity: ResultSet | null
  onKill?: (id: Cell) => void
}): React.JSX.Element {
  const node = (n: BlockingNode, depth: number): React.JSX.Element => {
    const s = summarize(engineKey, activity, n.id)
    const root = depth === 0
    return (
      <li key={`${depth}:${n.id}`}>
        <div
          className={cn(
            'group flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-hover',
            root && 'bg-danger/[0.04]'
          )}
        >
          <span
            className={cn(
              'mt-1.5 size-2 shrink-0 rounded-full',
              root ? 'bg-danger' : n.cycle ? 'bg-warn' : 'bg-warn/60'
            )}
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 text-[12px]">
              <span className="font-mono font-medium text-bright">{n.id}</span>
              {root && (
                <Badge tone="danger">
                  blocking {n.children.length}
                  {n.children.length === 1 ? ' session' : ' sessions'}
                </Badge>
              )}
              {n.cycle && (
                <Badge tone="warning" title="This session waits on a session that waits on it">
                  deadlock cycle
                </Badge>
              )}
              {[s.user, s.state, s.wait, s.time].filter(Boolean).map((t, i) => (
                <span key={i} className="text-muted">
                  {t}
                </span>
              ))}
            </div>
            {s.query && (
              <p className="truncate font-mono text-[11px] text-faint" title={s.query}>
                {s.query}
              </p>
            )}
          </div>
          {onKill && !n.cycle && (
            <Button
              size="xs"
              variant="ghost"
              className="opacity-0 group-hover:opacity-100 hover:text-danger"
              onClick={() => onKill(n.id)}
              title={root ? 'End this session to release its locks' : 'End this session'}
            >
              <OctagonX className="size-3.5" /> Kill
            </Button>
          )}
        </div>
        {n.children.length > 0 && (
          <ul className="ml-3 border-l border-line pl-3">
            {n.children.map((c) => node(c, depth + 1))}
          </ul>
        )}
      </li>
    )
  }
  return (
    <section>
      <SectionHeading icon={<GitFork className="size-3.5" />} title="Blocking chains">
        <span className="ml-auto text-[11px] font-normal tracking-normal text-faint normal-case">
          Each top-level session holds locks the sessions under it are waiting for
        </span>
      </SectionHeading>
      <ul className="max-h-80 space-y-1 overflow-y-auto rounded-lg border border-line bg-panel/70 p-2">
        {forest.map((n) => node(n, 0))}
      </ul>
    </section>
  )
}

/* ---------- Slow queries ---------- */

const ORDERS: { value: SlowQueryOrder; label: string; title: string }[] = [
  {
    value: 'total',
    label: 'Total time',
    title: 'Statements that cost the server the most overall'
  },
  { value: 'mean', label: 'Mean time', title: 'Statements that are slowest each time they run' },
  { value: 'calls', label: 'Calls', title: 'Statements that run most often' }
]

export function SlowQueriesSection({
  connection,
  engineKey,
  databases
}: {
  connection: ConnectionConfig
  engineKey: string
  databases: string[]
}): React.JSX.Element | null {
  if (engineKey === 'mongo') return <MongoProfiler connection={connection} databases={databases} />
  if (!slowQuerySql(engineKey, 'total')) return null
  return <SqlSlowQueries connection={connection} engineKey={engineKey} />
}

function SqlSlowQueries({
  connection,
  engineKey
}: {
  connection: ConnectionConfig
  engineKey: string
}): React.JSX.Element {
  const [order, setOrder] = useState<SlowQueryOrder>('total')
  const [legacy, setLegacy] = useState(false)
  const [source, setSource] = useState<MssqlSource>({ kind: 'plan-cache' })
  const stores = useSqlPanel(connection, engineKey === 'mssql' ? QUERY_STORE_DATABASES_SQL : null)
  const panel = useSqlPanel(connection, slowQuerySql(engineKey, order, { legacy, source }))

  // pg_stat_statements before PostgreSQL 13 names its timing columns total_time, mean_time, …
  useEffect(() => {
    if (engineKey === 'postgres' && !legacy && panel.error && isLegacyPgStatStatements(panel.error))
      setLegacy(true)
  }, [engineKey, legacy, panel.error])

  const menu = (row: number): MenuItem[] => {
    const set = panel.set
    const col = set?.columns.findIndex((c) => c.name === 'query') ?? -1
    const text = col >= 0 ? set?.rows[row]?.[col] : null
    if (typeof text !== 'string') return []
    const db = set?.columns.findIndex((c) => c.name === 'database' || c.name === 'db') ?? -1
    const database =
      source.kind === 'query-store' ? source.database : db >= 0 ? set?.rows[row]?.[db] : null
    return [
      'separator',
      {
        label: 'Open in a query tab',
        icon: <Code2 />,
        onSelect: () =>
          newQueryTab(connection.id, typeof database === 'string' ? database : undefined, text)
      }
    ]
  }

  const storeNames = (stores.set?.rows ?? []).map((r) => String(r[0]))
  const sourceLabel =
    engineKey === 'postgres'
      ? 'pg_stat_statements'
      : engineKey === 'mysql'
        ? 'performance_schema digests'
        : source.kind === 'plan-cache'
          ? 'Plan cache (since the plans were cached)'
          : `Query Store in ${source.database}`

  return (
    <section>
      <SectionHeading icon={<Gauge className="size-3.5" />} title="Slow queries">
        <Button size="icon-sm" variant="ghost" onClick={panel.reload} title="Refresh">
          <RefreshCw className={panel.loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
        </Button>
        <Segmented
          size="sm"
          value={order}
          onChange={setOrder}
          options={ORDERS}
          className="font-normal tracking-normal normal-case"
        />
        {engineKey === 'mssql' && (
          <Select
            value={source.kind === 'plan-cache' ? '' : source.database}
            onChange={(e) =>
              setSource(
                e.target.value
                  ? { kind: 'query-store', database: e.target.value }
                  : { kind: 'plan-cache' }
              )
            }
            className="w-52 font-normal tracking-normal normal-case"
            selectClassName="h-6 text-[11.5px]"
            title="Statement statistics source"
          >
            <option value="">Plan cache (all databases)</option>
            {storeNames.map((n) => (
              <option key={n} value={n}>
                Query Store: {n}
              </option>
            ))}
          </Select>
        )}
        <span className="ml-auto text-[11px] font-normal tracking-normal text-faint normal-case">
          Top 50 · {sourceLabel}
        </span>
      </SectionHeading>
      <GridBox
        panel={panel}
        empty="No statement statistics recorded yet"
        menu={menu}
        hint={panel.error ? slowQuerySetupHint(engineKey, panel.error) : null}
      />
    </section>
  )
}

interface ProfileLevel {
  was: number
  slowms: number
}

/** MongoDB's slow operations come from the per-database profiler (system.profile). */
function MongoProfiler({
  connection,
  databases
}: {
  connection: ConnectionConfig
  databases: string[]
}): React.JSX.Element {
  const [database, setDatabase] = useState(databases[0] ?? '')
  const [level, setLevel] = useState<ProfileLevel | null>(null)
  const [slowms, setSlowms] = useState('100')
  const [ops, setOps] = useState<ResultSet | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!database && databases.length) setDatabase(databases[0])
  }, [database, databases])

  const load = useCallback(async () => {
    if (!database) return
    setLoading(true)
    setError(null)
    try {
      const status = await api.mongo(connection.id, '__meta', {
        op: 'runCommand',
        database,
        command: { profile: -1 }
      })
      const value = status.value as Record<string, unknown>
      const next = { was: Number(scalarText(value.was)), slowms: Number(scalarText(value.slowms)) }
      setLevel(next)
      if (next.slowms) setSlowms(String(next.slowms))
      const out = await api.mongo(connection.id, '__meta', {
        op: 'find',
        database,
        collection: 'system.profile',
        filter: {},
        sort: { millis: -1 },
        projection: {
          op: 1,
          ns: 1,
          millis: 1,
          ts: 1,
          planSummary: 1,
          docsExamined: 1,
          keysExamined: 1,
          nreturned: 1,
          appName: 1,
          command: 1
        },
        limit: 50
      })
      setOps({
        ...documentsToGrid(out.documents),
        rowCount: out.documents.length,
        truncated: false
      })
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setLoading(false)
    }
  }, [connection.id, database])

  useEffect(() => {
    void load()
  }, [load])

  const setProfile = async (on: boolean): Promise<void> => {
    try {
      const ms = Number(slowms)
      if (on && (!Number.isInteger(ms) || ms < 0)) throw new Error('Enter a whole number of ms')
      await api.mongo(connection.id, '__meta', {
        op: 'runCommand',
        database,
        command: on ? { profile: 1, slowms: ms } : { profile: 0 }
      })
      toast(
        on ? `Profiling operations over ${ms} ms in ${database}` : `Profiler off in ${database}`
      )
      void load()
    } catch (e) {
      toastError(e)
    }
  }

  const menu = (row: number): MenuItem[] => {
    const set = ops
    const nsCol = set?.columns.findIndex((c) => c.name === 'ns') ?? -1
    const ns = nsCol >= 0 ? set?.rows[row]?.[nsCol] : null
    if (typeof ns !== 'string' || !ns.includes('.')) return []
    const collection = ns.slice(ns.indexOf('.') + 1)
    return [
      'separator',
      {
        label: 'Open collection in a shell tab',
        icon: <Code2 />,
        onSelect: () =>
          newQueryTab(
            connection.id,
            database,
            `${shellCollection(collection)}.find({})\n  .limit(50)`
          )
      }
    ]
  }

  const panel: SqlPanel = { set: ops, error, loading, reload: () => void load() }
  return (
    <section>
      <SectionHeading icon={<Gauge className="size-3.5" />} title="Slow operations">
        <Button size="icon-sm" variant="ghost" onClick={() => void load()} title="Refresh">
          <RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
        </Button>
        <Select
          value={database}
          onChange={(e) => setDatabase(e.target.value)}
          className="w-44 font-normal tracking-normal normal-case"
          selectClassName="h-6 text-[11.5px]"
        >
          {databases.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </Select>
        {level && (
          <Badge tone={level.was ? 'success' : 'neutral'} className="normal-case">
            {level.was === 2
              ? 'Profiling all operations'
              : level.was === 1
                ? `Profiling over ${level.slowms} ms`
                : 'Profiler off'}
          </Badge>
        )}
        <span className="ml-auto flex items-center gap-1.5 font-normal tracking-normal normal-case">
          <Input
            value={slowms}
            onChange={(e) => setSlowms(e.target.value)}
            className="h-6 w-16 text-[11.5px]"
            title="Slow operation threshold in milliseconds"
          />
          <span className="text-[11px] text-faint">ms</span>
          <Button size="xs" onClick={() => void setProfile(true)} disabled={connection.readOnly}>
            Profile slow ops
          </Button>
          {!!level?.was && (
            <Button size="xs" variant="ghost" onClick={() => void setProfile(false)}>
              Turn off
            </Button>
          )}
        </span>
      </SectionHeading>
      <GridBox
        panel={panel}
        empty={
          level?.was
            ? 'No slow operations recorded yet'
            : 'Turn on the profiler to record slow operations in this database'
        }
        menu={menu}
      />
    </section>
  )
}
