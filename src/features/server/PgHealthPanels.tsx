import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  Code2,
  FileCode2,
  HeartPulse,
  ListTree,
  OctagonX,
  RefreshCw,
  Square,
  Wrench
} from 'lucide-react'
import type { Cell, ConnectionConfig } from '@/lib/api'
import {
  dropIndexSql,
  exactBloatSql,
  HEALTH_CONTEXT_SQL,
  indexRows,
  indexUsageSql,
  parseHealthContext,
  progressSql,
  reindexSql,
  rowTable,
  tableHealthSql,
  withHealthFlags,
  withIndexIssues,
  type IndexFilter
} from '@/lib/pg-health'
import type { SessionAction } from '@/lib/sessions'
import { newQueryTab, openMaintenance } from '@/lib/workspace'
import type { MenuItem } from '@/components/ContextMenu'
import { ResultGrid } from '@/components/grid/ResultGrid'
import { Badge, Button, EmptyState, ErrorText, Input, Segmented, Select } from '@/components/ui'
import { SectionHeading } from './PerformancePanels'
import { useSqlPanel, type SqlPanel } from './useSqlPanel'

/** Polls the progress views this often while something runs, and this often while idle. */
const BUSY_SECONDS = 2
const IDLE_SECONDS = 15

const INDEX_FILTERS: { value: IndexFilter; label: string; title: string }[] = [
  {
    value: 'problems',
    label: 'Problems',
    title: 'Unused, duplicate, redundant and invalid indexes'
  },
  {
    value: 'unused',
    label: 'Unused',
    title:
      'Never scanned since statistics were reset; primary key, unique and constraint indexes aren’t counted'
  },
  {
    value: 'duplicate',
    label: 'Duplicate',
    title: 'Same table, keys, method, expressions and predicate as another index'
  },
  {
    value: 'redundant',
    label: 'Redundant',
    title: 'Its keys are the leading keys of another index with the same predicate'
  },
  {
    value: 'invalid',
    label: 'Invalid',
    title: 'Left behind by a failed CREATE INDEX CONCURRENTLY'
  },
  { value: 'all', label: 'All', title: 'Every index in this database' }
]

/**
 * PostgreSQL table health, index usage and the progress of long-running
 * commands, for one database of the server.
 */
export function PgHealthSection({
  connection,
  databases,
  defaultDatabase,
  active,
  onSessionAction
}: {
  connection: ConnectionConfig
  databases: string[]
  defaultDatabase: string
  /** The tab is in front and the window visible, so progress may poll */
  active: boolean
  onSessionAction?: (action: SessionAction, id: Cell) => Promise<void>
}): React.JSX.Element {
  const [database, setDatabase] = useState(defaultDatabase)
  useEffect(() => {
    if (!database && defaultDatabase) setDatabase(defaultDatabase)
  }, [database, defaultDatabase])
  const contextPanel = useSqlPanel(connection, database ? HEALTH_CONTEXT_SQL : null, database)
  const context = parseHealthContext(contextPanel.set)
  const picker = (
    <Select
      value={database}
      onChange={(e) => setDatabase(e.target.value)}
      className="w-44 font-normal tracking-normal normal-case"
      selectClassName="h-6 text-[11.5px]"
      title="Database whose tables and indexes to show"
    >
      {[...new Set([defaultDatabase, ...databases])].filter(Boolean).map((d) => (
        <option key={d} value={d}>
          {d}
        </option>
      ))}
    </Select>
  )
  if (contextPanel.error)
    return (
      <section>
        <SectionHeading icon={<HeartPulse className="size-3.5" />} title="Table health">
          {picker}
        </SectionHeading>
        <div className="rounded-lg border border-line p-4">
          <ErrorText error={contextPanel.error} />
        </div>
      </section>
    )
  if (!context) return <></>
  return (
    <>
      <TableHealth connection={connection} database={database} context={context} picker={picker} />
      <IndexUsage connection={connection} database={database} context={context} />
      <Progress
        connection={connection}
        database={database}
        version={context.version}
        allStats={context.allStats}
        active={active}
        onSessionAction={onSessionAction}
      />
    </>
  )
}

function Box({
  panel,
  children,
  empty,
  height = 'h-80'
}: {
  panel: SqlPanel
  children: React.ReactNode
  empty: string | null
  height?: string
}): React.JSX.Element {
  return (
    <div className={`${height} overflow-hidden rounded-lg border border-line`}>
      {panel.error ? (
        <div className="p-4">
          <ErrorText error={panel.error} />
        </div>
      ) : !panel.set ? (
        <EmptyState title="Loading…" />
      ) : empty ? (
        <EmptyState title={empty} />
      ) : (
        children
      )}
    </div>
  )
}

function Hint({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="ml-auto truncate text-[11px] font-normal tracking-normal text-faint normal-case">
      {children}
    </span>
  )
}

function since(statsReset: string | null): string {
  return statsReset
    ? `since statistics were reset ${statsReset.slice(0, 19)}`
    : 'since statistics were last reset (no reset recorded)'
}

/* ---------- Table health ---------- */

function TableHealth({
  connection,
  database,
  context,
  picker
}: {
  connection: ConnectionConfig
  database: string
  context: NonNullable<ReturnType<typeof parseHealthContext>>
  picker: React.ReactNode
}): React.JSX.Element {
  const panel = useSqlPanel(connection, tableHealthSql(context.version), database)
  const [flagged, setFlagged] = useState<'flagged' | 'all'>('all')
  const [filter, setFilter] = useState('')
  const set = useMemo(
    () => (panel.set ? withHealthFlags(panel.set, flagged === 'flagged') : null),
    [panel.set, flagged]
  )
  const attention = useMemo(
    () => (panel.set ? withHealthFlags(panel.set, true).rows.length : 0),
    [panel.set]
  )

  const menu = (row: number): MenuItem[] => {
    const table = set && rowTable(set, row)
    if (!table) return []
    const maintain = (task: 'vacuum' | 'analyze', options: Record<string, boolean> = {}): void =>
      openMaintenance(connection.id, database, { task, tables: [table], options })
    const items: MenuItem[] = [
      'separator',
      {
        label: 'Vacuum…',
        icon: <Wrench />,
        onSelect: () => maintain('vacuum', { analyze: true })
      },
      {
        label: 'Vacuum freeze…',
        icon: <Wrench />,
        onSelect: () => maintain('vacuum', { analyze: true, freeze: true })
      },
      { label: 'Analyze…', icon: <Wrench />, onSelect: () => maintain('analyze') }
    ]
    if (context.pgstattuple)
      items.push({
        label: 'Exact bloat with pgstattuple',
        icon: <Code2 />,
        onSelect: () => newQueryTab(connection.id, database, exactBloatSql(table))
      })
    return items
  }

  return (
    <section>
      <SectionHeading icon={<HeartPulse className="size-3.5" />} title="Table health">
        <Button size="icon-sm" variant="ghost" onClick={panel.reload} title="Refresh">
          <RefreshCw className={panel.loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
        </Button>
        {picker}
        <Segmented
          size="sm"
          value={flagged}
          onChange={setFlagged}
          options={[
            { value: 'all', label: 'All tables' },
            {
              value: 'flagged',
              label: 'Needs attention',
              count: attention,
              title: `Dead rows over the autovacuum threshold or 20%, stale statistics, transaction ID age past 75% of autovacuum_freeze_max_age, estimated bloat over 30%, or autovacuum turned off`
            }
          ]}
          className="font-normal tracking-normal normal-case"
        />
        <Input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter tables…"
          className="h-6 w-40 text-[11.5px] font-normal tracking-normal normal-case"
        />
        <Hint>
          est_bloat is a statistics-based estimate
          {context.pgstattuple ? '; right-click for exact numbers' : ''} · right-click to vacuum or
          analyze
        </Hint>
      </SectionHeading>
      <Box
        panel={panel}
        empty={
          set && !set.rows.length
            ? flagged === 'flagged'
              ? 'No tables need attention'
              : 'No user tables in this database'
            : null
        }
      >
        {set && (
          <ResultGrid columns={set.columns} rows={set.rows} filter={filter} cellMenuItems={menu} />
        )}
      </Box>
    </section>
  )
}

/* ---------- Index usage ---------- */

function IndexUsage({
  connection,
  database,
  context
}: {
  connection: ConnectionConfig
  database: string
  context: NonNullable<ReturnType<typeof parseHealthContext>>
}): React.JSX.Element {
  const panel = useSqlPanel(connection, indexUsageSql(context.version), database)
  const [filter, setFilter] = useState<IndexFilter>('problems')
  const view = useMemo(
    () => (panel.set ? withIndexIssues(panel.set, filter) : null),
    [panel.set, filter]
  )
  const rows = useMemo(() => (panel.set ? indexRows(panel.set) : []), [panel.set])
  const counts = useMemo(() => {
    const out: Partial<Record<IndexFilter, number>> = {}
    if (!panel.set) return out
    for (const f of INDEX_FILTERS)
      if (f.value !== 'all') out[f.value] = withIndexIssues(panel.set, f.value).set.rows.length
    return out
  }, [panel.set])

  const menu = (row: number): MenuItem[] => {
    const index = view && rows[view.source[row]]
    if (!index) return []
    const open = (sql: string): void => newQueryTab(connection.id, database, sql)
    const items: MenuItem[] = ['separator']
    if (index.constraint)
      items.push({
        label: 'Script DROP CONSTRAINT',
        icon: <FileCode2 />,
        onSelect: () => open(dropIndexSql(index, { concurrently: false }))
      })
    else
      items.push(
        {
          label: 'Script DROP INDEX CONCURRENTLY',
          icon: <FileCode2 />,
          onSelect: () => open(dropIndexSql(index, { concurrently: true }))
        },
        {
          label: 'Script DROP INDEX',
          icon: <FileCode2 />,
          onSelect: () => open(dropIndexSql(index, { concurrently: false }))
        }
      )
    if (!index.valid)
      items.push({
        label: 'Script REINDEX CONCURRENTLY',
        icon: <FileCode2 />,
        onSelect: () => open(reindexSql(index))
      })
    return items
  }

  return (
    <section>
      <SectionHeading icon={<ListTree className="size-3.5" />} title="Index usage">
        <Button size="icon-sm" variant="ghost" onClick={panel.reload} title="Refresh">
          <RefreshCw className={panel.loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
        </Button>
        <Segmented
          size="sm"
          value={filter}
          onChange={setFilter}
          options={INDEX_FILTERS.map((f) => ({ ...f, count: counts[f.value] }))}
          className="font-normal tracking-normal normal-case"
        />
        <Hint>
          Scans counted on this server {since(context.statsReset)} · right-click to script a drop
        </Hint>
      </SectionHeading>
      <Box
        panel={panel}
        empty={
          view && !view.set.rows.length
            ? filter === 'all'
              ? 'No user indexes in this database'
              : 'No indexes match'
            : null
        }
      >
        {view && (
          <ResultGrid columns={view.set.columns} rows={view.set.rows} cellMenuItems={menu} />
        )}
      </Box>
    </section>
  )
}

/* ---------- Progress ---------- */

function Progress({
  connection,
  database,
  version,
  allStats,
  active,
  onSessionAction
}: {
  connection: ConnectionConfig
  database: string
  version: number
  allStats: boolean
  active: boolean
  onSessionAction?: (action: SessionAction, id: Cell) => Promise<void>
}): React.JSX.Element {
  const panel = useSqlPanel(connection, progressSql(version), database)
  const running = panel.set?.rows.length ?? 0
  const reload = useRef(panel.reload)
  reload.current = panel.reload
  const busy = useRef(false)
  busy.current = panel.loading
  // Polls quickly while something runs, so phases and percentages move
  useEffect(() => {
    if (!active) return
    const timer = setInterval(
      () => {
        if (!busy.current) reload.current()
      },
      (running ? BUSY_SECONDS : IDLE_SECONDS) * 1000
    )
    return () => clearInterval(timer)
  }, [active, running])

  const menu = (row: number): MenuItem[] => {
    const set = panel.set
    const col = set?.columns.findIndex((c) => c.name === 'pid') ?? -1
    const pid = col >= 0 ? (set?.rows[row]?.[col] ?? null) : null
    if (pid === null || !onSessionAction) return []
    const act = (action: SessionAction): void =>
      void onSessionAction(action, pid).then(() => reload.current())
    return [
      'separator',
      { label: 'Cancel query', icon: <Square />, onSelect: () => act('cancel') },
      { label: 'Kill session', icon: <OctagonX />, danger: true, onSelect: () => act('kill') }
    ]
  }

  return (
    <section>
      <SectionHeading icon={<Activity className="size-3.5" />} title="Progress">
        <Button size="icon-sm" variant="ghost" onClick={panel.reload} title="Refresh">
          <RefreshCw className={panel.loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
        </Button>
        {running > 0 && (
          <Badge tone="warning" className="normal-case">
            {running} running
          </Badge>
        )}
        <Hint>
          VACUUM, ANALYZE, CREATE INDEX, CLUSTER{version >= 140000 ? ', COPY' : ''} and base backups
          on the whole server · every {running ? BUSY_SECONDS : IDLE_SECONDS} s
          {!allStats && ' · other roles’ queries need pg_read_all_stats'}
        </Hint>
      </SectionHeading>
      <Box
        panel={panel}
        height="h-48"
        empty={panel.set && !running ? 'No long-running maintenance commands' : null}
      >
        {panel.set && (
          <ResultGrid columns={panel.set.columns} rows={panel.set.rows} cellMenuItems={menu} />
        )}
      </Box>
    </section>
  )
}
