import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Code2, Copy, Gauge, RefreshCw, Snail } from 'lucide-react'
import { api, type Cell, type ConnectionConfig, type ResultSet } from '@/lib/api'
import { connectedInfo, isMariaDb } from '@/lib/mariadb'
import { confirmProductionWrite } from '@/lib/production'
import {
  ENABLE_SLOW_LOG_SQL,
  explainable,
  groupSlowLog,
  groupsToSet,
  logsToTable,
  parseSlowLogStatus,
  SLOW_LOG_GROUP_LIMIT,
  SLOW_LOG_GROUP_SORTS,
  SLOW_LOG_PAGE_SIZE,
  SLOW_LOG_RANGES,
  SLOW_LOG_SORTS,
  slowLogCountSql,
  slowLogEntriesSql,
  slowLogGroupSql,
  slowLogHint,
  slowLogStatusSql,
  type SlowLogFilter,
  type SlowLogGroupSort,
  type SlowLogSort,
  type SlowLogStatus
} from '@/lib/slow-log'
import { toast, toastError } from '@/lib/toast'
import { confirm, newQueryTab, statusStore } from '@/lib/workspace'
import type { MenuItem } from '@/components/ContextMenu'
import { ResultGrid } from '@/components/grid/ResultGrid'
import { Badge, Button, EmptyState, ErrorText, Input, Segmented, Select } from '@/components/ui'
import { SectionHeading } from './PerformancePanels'
import { useSqlPanel, type SqlPanel } from './useSqlPanel'

type View = 'entries' | 'grouped'

const VIEWS: { value: View; label: string; title: string }[] = [
  { value: 'entries', label: 'Entries', title: 'Each logged execution' },
  {
    value: 'grouped',
    label: 'Grouped',
    title: 'Executions grouped by statement shape, literals and IN lists ignored'
  }
]

const copy = (text: string): void =>
  void navigator.clipboard.writeText(text).then(() => toast('Copied to the clipboard'), toastError)

/**
 * MySQL and MariaDB's slow query log, read from mysql.slow_log. Unlike the performance_schema
 * digests it keeps each execution with its literals, so a slow run can be explained as it ran.
 */
export function SlowLogPanel({ connection }: { connection: ConnectionConfig }): React.JSX.Element {
  const mariadb = isMariaDb(connectedInfo(statusStore.use()[connection.id]))
  const statusPanel = useSqlPanel(connection, slowLogStatusSql(mariadb))
  const status = useMemo(() => parseSlowLogStatus(statusPanel.set), [statusPanel.set])
  const table = !!status && logsToTable(status)

  const [view, setView] = useState<View>('grouped')
  const [range, setRange] = useState('1h')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [hideOwn, setHideOwn] = useState(true)
  const [sort, setSort] = useState<SlowLogSort>('start_time')
  const [groupSort, setGroupSort] = useState<SlowLogGroupSort>('total')
  const [page, setPage] = useState(0)

  const filter = useMemo<SlowLogFilter>(
    () => ({
      range:
        range === 'custom'
          ? { from, to }
          : { minutes: SLOW_LOG_RANGES.find((r) => r.value === range)?.minutes ?? null },
      hideOwn
    }),
    [range, from, to, hideOwn]
  )
  useEffect(() => setPage(0), [filter, sort])

  const entries = useSqlPanel(
    connection,
    table && view === 'entries' ? slowLogEntriesSql(filter, { sort, page, mariadb }) : null
  )
  const count = useSqlPanel(
    connection,
    table && view === 'entries' ? slowLogCountSql(filter) : null
  )
  const raw = useSqlPanel(connection, table && view === 'grouped' ? slowLogGroupSql(filter) : null)
  const groups = useMemo(
    () => (raw.set ? groupSlowLog(raw.set, groupSort) : []),
    [raw.set, groupSort]
  )
  const groupedSet = useMemo(() => (raw.set ? groupsToSet(groups) : null), [raw.set, groups])
  const grouped: SqlPanel = { ...raw, set: groupedSet }

  const total = Number(count.set?.rows[0]?.[0] ?? 0)
  const pages = Math.max(1, Math.ceil(total / SLOW_LOG_PAGE_SIZE))
  const panel = view === 'entries' ? entries : grouped
  const reload = (): void => {
    statusPanel.reload()
    if (view === 'entries') {
      entries.reload()
      count.reload()
    } else raw.reload()
  }

  const actions = (text: string, database: string, normalized?: string): MenuItem[] => [
    'separator',
    {
      label: 'Open in a query tab',
      icon: <Code2 />,
      onSelect: () => newQueryTab(connection.id, database || undefined, text)
    },
    {
      label: 'Explain',
      icon: <Gauge />,
      disabled: !explainable(text),
      onSelect: () =>
        newQueryTab(connection.id, database || undefined, text, { autorun: 'explain' })
    },
    { label: 'Copy query', icon: <Copy />, onSelect: () => copy(text) },
    ...(normalized
      ? [{ label: 'Copy normalized statement', icon: <Copy />, onSelect: () => copy(normalized) }]
      : [])
  ]

  const menu = (row: number): MenuItem[] => {
    if (view === 'grouped') {
      const g = groups[row]
      return g ? actions(g.sample, g.db, g.fingerprint) : []
    }
    const set = entries.set
    const text = cellAt(set, row, 'sql_text')
    return typeof text === 'string' ? actions(text, String(cellAt(set, row, 'db') ?? '')) : []
  }

  return (
    <section>
      <SectionHeading icon={<Snail className="size-3.5" />} title="Slow query log">
        <Button size="icon-sm" variant="ghost" onClick={reload} title="Refresh">
          <RefreshCw
            className={statusPanel.loading || panel.loading ? 'size-3.5 animate-spin' : 'size-3.5'}
          />
        </Button>
        {status && (
          <Badge tone={status.enabled ? 'success' : 'neutral'} className="normal-case">
            {status.enabled
              ? `Logging over ${status.longQueryTime ?? '?'} s to ${status.outputs.join(', ') || 'NONE'}`
              : 'Slow query log off'}
          </Badge>
        )}
        <span className="ml-auto text-[11px] font-normal tracking-normal text-faint normal-case">
          {table
            ? 'mysql.slow_log · right-click a row to open, explain or copy its query'
            : 'Each statement slower than long_query_time'}
        </span>
      </SectionHeading>

      {status && <Settings status={status} />}

      {statusPanel.error ? (
        <div className="rounded-lg border border-line p-4">
          <ErrorText error={statusPanel.error} />
        </div>
      ) : !status ? (
        <div className="h-24 rounded-lg border border-line">
          <EmptyState title="Loading…" />
        </div>
      ) : (
        <>
          {(!status.enabled || !table) && (
            <EnableHint connection={connection} status={status} onDone={statusPanel.reload} />
          )}
          {table && (
            <>
              <div className="mb-2 flex flex-wrap items-center gap-2 text-[11.5px]">
                <Segmented size="sm" value={view} onChange={setView} options={VIEWS} />
                <Select
                  value={range}
                  onChange={(e) => setRange(e.target.value)}
                  className="w-36"
                  selectClassName="h-6 text-[11.5px]"
                  title="Which entries to read, by start_time"
                >
                  {SLOW_LOG_RANGES.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                  <option value="custom">Custom range…</option>
                </Select>
                {range === 'custom' && (
                  <>
                    <Input
                      type="datetime-local"
                      step={1}
                      value={from}
                      onChange={(e) => setFrom(e.target.value)}
                      className="h-6 w-48 text-[11.5px]"
                      title="From (inclusive, server time)"
                    />
                    <span className="text-faint">to</span>
                    <Input
                      type="datetime-local"
                      step={1}
                      value={to}
                      onChange={(e) => setTo(e.target.value)}
                      className="h-6 w-48 text-[11.5px]"
                      title="To (exclusive, server time)"
                    />
                  </>
                )}
                {view === 'entries' ? (
                  <Select
                    value={sort}
                    onChange={(e) => setSort(e.target.value as SlowLogSort)}
                    className="w-40"
                    selectClassName="h-6 text-[11.5px]"
                  >
                    {SLOW_LOG_SORTS.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Segmented
                    size="sm"
                    value={groupSort}
                    onChange={setGroupSort}
                    options={SLOW_LOG_GROUP_SORTS}
                  />
                )}
                <label
                  className="flex items-center gap-1.5 text-muted"
                  title="Leave out reads of mysql.slow_log, including this panel's own"
                >
                  <input
                    type="checkbox"
                    checked={hideOwn}
                    onChange={(e) => setHideOwn(e.target.checked)}
                  />
                  Hide slow-log reads
                </label>
                <span className="ml-auto flex items-center gap-1 text-faint">
                  {view === 'entries' ? (
                    <>
                      {total.toLocaleString()} entries · page {page + 1} of {pages}
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        disabled={page === 0}
                        onClick={() => setPage(page - 1)}
                        title="Newer page"
                      >
                        <ChevronLeft className="size-3.5" />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        disabled={page + 1 >= pages}
                        onClick={() => setPage(page + 1)}
                        title="Next page"
                      >
                        <ChevronRight className="size-3.5" />
                      </Button>
                    </>
                  ) : raw.set ? (
                    `${groups.length.toLocaleString()} statements from ${raw.set.rows.length.toLocaleString()} entries${
                      raw.set.rows.length >= SLOW_LOG_GROUP_LIMIT ? ' (the newest only)' : ''
                    }`
                  ) : null}
                </span>
              </div>
              <div className="h-80 overflow-hidden rounded-lg border border-line">
                {panel.error ? (
                  <div className="space-y-2 p-4">
                    <ErrorText error={panel.error} />
                    {slowLogHint(panel.error) && (
                      <p className="text-xs text-muted">{slowLogHint(panel.error)}</p>
                    )}
                  </div>
                ) : panel.set ? (
                  panel.set.rows.length ? (
                    <ResultGrid
                      columns={panel.set.columns}
                      rows={panel.set.rows}
                      cellMenuItems={menu}
                    />
                  ) : (
                    <EmptyState title="No slow queries logged in this range" />
                  )
                ) : (
                  <EmptyState title="Loading…" />
                )}
              </div>
            </>
          )}
        </>
      )}
    </section>
  )
}

function cellAt(set: ResultSet | null, row: number, name: string): Cell {
  const col = set?.columns.findIndex((c) => c.name === name) ?? -1
  return col >= 0 ? (set?.rows[row]?.[col] ?? null) : null
}

function Settings({ status }: { status: SlowLogStatus }): React.JSX.Element {
  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {status.settings.map(([name, value]) => (
        <span
          key={name}
          className="rounded-md border border-line bg-panel/70 px-2 py-0.5 font-mono text-[11px] select-text"
        >
          <span className="text-muted">{name}</span>{' '}
          <span className="text-bright">{value ?? 'NULL'}</span>
        </span>
      ))}
    </div>
  )
}

/** What's configured when the log is off or file-only, and the statement that changes it. */
function EnableHint({
  connection,
  status,
  onDone
}: {
  connection: ConnectionConfig
  status: SlowLogStatus
  onDone: () => void
}): React.JSX.Element {
  const enable = async (): Promise<void> => {
    const ok = await confirm({
      title: 'Turn on the slow query log?',
      message:
        'This changes server-wide settings for every client until the server restarts. long_query_time applies to connections opened afterwards. It needs the SUPER or SYSTEM_VARIABLES_ADMIN privilege.',
      code: ENABLE_SLOW_LOG_SQL,
      confirmLabel: 'Run SET GLOBAL'
    })
    if (!ok) return
    // SET isn't a data write, so the production guard is asked explicitly
    const allowed = await confirmProductionWrite(connection, {
      action: 'This changes global slow query log settings',
      dangers: [],
      code: ENABLE_SLOW_LOG_SQL
    })
    if (!allowed) return
    try {
      const out = await api.execute(connection.id, '__meta', '', ENABLE_SLOW_LOG_SQL, {
        confirmed: true
      })
      if (out.error) throw new Error(out.error.message)
      toast('Slow query log on, writing to TABLE and FILE')
      onDone()
    } catch (e) {
      toastError(e)
    }
  }
  const where = !status.enabled
    ? 'The slow query log is off.'
    : status.outputs.includes('FILE')
      ? `The log goes to a file on the server only (slow_query_log_file), which this app can't read.`
      : `log_output is ${status.outputs.join(', ') || 'empty'}, so nothing is written to mysql.slow_log.`
  return (
    <div className="mb-2 space-y-2 rounded-lg border border-line bg-panel/70 p-3 text-xs text-muted">
      <p>
        {where} To read it here, log to the mysql.slow_log table as well; add the settings to my.cnf
        to keep them after a restart.
      </p>
      <div className="flex items-center gap-2">
        <code className="flex-1 truncate rounded-md bg-canvas px-2 py-1 font-mono text-[11.5px] text-fg select-text">
          {ENABLE_SLOW_LOG_SQL}
        </code>
        <Button size="xs" variant="ghost" onClick={() => copy(ENABLE_SLOW_LOG_SQL)}>
          <Copy className="size-3.5" /> Copy
        </Button>
        <Button
          size="xs"
          onClick={() => void enable()}
          disabled={connection.readOnly}
          title={connection.readOnly ? 'This connection is read-only' : undefined}
        >
          Turn on…
        </Button>
      </div>
    </div>
  )
}
