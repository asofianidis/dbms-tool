import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  ClipboardCopy,
  Download,
  FileSpreadsheet,
  GitCompareArrows,
  HardDriveDownload,
  ListChecks,
  ListFilter,
  MessageSquareText,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Search,
  TableProperties,
  Workflow,
  X
} from 'lucide-react'
import type {
  Cell,
  ColumnMeta,
  ConnectionConfig,
  ExecOptions,
  ExecOutput,
  ResultSet,
  StreamFormat,
  TableInfo
} from '@/lib/api'
import { cn } from '@/lib/cn'
import type { Dialect } from '@/lib/engines'
import { copyText, exportRows, serialize, type ExportFormat, type FileFormat } from '@/lib/export'
import { formatDuration, plural } from '@/lib/format'
import { addInsert } from '@/lib/pending'
import type { Plan } from '@/lib/plan'
import { diffResults } from '@/lib/result-diff'
import { qualified, type TableRef } from '@/lib/sql'
import { createStore } from '@/lib/store'
import { tabsStore } from '@/lib/workspace'
import { ResultGrid, type GridMarks } from '@/components/grid/ResultGrid'
import { showMenuAt, type MenuItem } from '@/components/ContextMenu'
import { Badge, Button, EmptyState, ProgressBar, Select } from '@/components/ui'
import { selectionSummaryStore } from '@/components/shell/StatusBar'
import { ChangesPanel } from '../table/ChangesPanel'
import { commitPendingChanges, fetchCellValue, usePendingEdits } from '../table/usePendingEdits'
import { PlanView } from './PlanView'

export interface RunResult {
  output?: ExecOutput
  /** Failure before the server answered (not connected, blocked by read-only, …) */
  error?: string
  /** Offset of the executed text within the editor, for error positions */
  offset: number
  sql: string
  /** Set when the run was an Explain whose output could be read as a plan */
  plan?: Plan
  /** A re-run of the same text (more rows, refresh after edits): keep the open view */
  keepView?: boolean
}

/** A result kept aside so later runs don't replace it, e.g. to compare against. */
export interface PinnedResult {
  id: string
  label: string
  columns: ColumnMeta[]
  rows: Cell[][]
  rowCount: number
  truncated: boolean
  sql: string
  at: number
}

/** Pinned results per query tab; in memory only, since results can be large */
export const pinnedResultsStore = createStore<Record<string, PinnedResult[]>>({})

// Closing a tab drops its pins
tabsStore.subscribe(() => {
  const pins = pinnedResultsStore.get()
  const open = new Set(tabsStore.get().tabs.map((t) => t.id))
  if (Object.keys(pins).some((id) => !open.has(id)))
    pinnedResultsStore.set(Object.fromEntries(Object.entries(pins).filter(([id]) => open.has(id))))
})

/** Where a result's rows came from, when they can be edited in place. */
export interface ResultEditTarget {
  tableRef: TableRef
  info: TableInfo
  /** Result columns that don't map onto a table column */
  readOnly: Set<number>
  /** Runs SQL on the tab's session */
  execute: (sql: string, options?: ExecOptions) => Promise<ExecOutput>
  confirmDangerous: boolean
  /** Production connections confirm every commit */
  connection?: ConnectionConfig
  /** Why committing is held back, e.g. an open transaction */
  blocked?: string
  /** Re-runs the query once changes are committed */
  onCommitted: () => void
}

export function exportMenu(
  anchor: HTMLElement,
  set: Pick<ResultSet, 'columns' | 'rows'>,
  name: string,
  dialect?: Dialect,
  table?: string,
  /** Runs the query again, streaming every row to a file */
  full?: { run: (format: StreamFormat) => void; disabled?: string }
): void {
  const run = (format: FileFormat) => () =>
    void exportRows(format, set.columns, set.rows, name, { dialect, table })
  const copy = (format: ExportFormat, label: string) => () =>
    void copyText(
      serialize(format, set.columns, set.rows, { dialect, table }),
      `Copied ${set.rows.length} rows as ${label}`
    )
  const items: MenuItem[] = [
    { heading: `Save ${plural(set.rows.length, 'loaded row')} as` },
    { label: 'CSV', icon: <Download />, onSelect: run('csv') },
    { label: 'Excel (XLSX)', icon: <FileSpreadsheet />, onSelect: run('xlsx') },
    { label: 'JSON', icon: <Download />, onSelect: run('json') },
    { label: 'TSV', icon: <Download />, onSelect: run('tsv') },
    { label: 'Markdown', icon: <Download />, onSelect: run('markdown') },
    { label: 'SQL INSERT statements', icon: <Download />, onSelect: run('sql') }
  ]
  if (full) {
    const stream = (format: StreamFormat) => () => full.run(format)
    items.push(
      'separator',
      {
        label: 'Export full result',
        icon: <HardDriveDownload />,
        disabled: !!full.disabled,
        submenu: [
          { heading: 'Runs the query again and streams every row to disk' },
          { label: 'CSV', onSelect: stream('csv') },
          { label: 'Excel (XLSX)', onSelect: stream('xlsx') },
          { label: 'JSON', onSelect: stream('json') },
          { label: 'TSV', onSelect: stream('tsv') }
        ]
      },
      ...(full.disabled ? [{ label: full.disabled, disabled: true }] : [])
    )
  }
  items.push(
    'separator',
    { heading: 'Copy all rows as' },
    { label: 'TSV (spreadsheet)', icon: <ClipboardCopy />, onSelect: copy('tsv', 'TSV') },
    { label: 'JSON', icon: <ClipboardCopy />, onSelect: copy('json', 'JSON') },
    { label: 'Markdown', icon: <ClipboardCopy />, onSelect: copy('markdown', 'Markdown') },
    { label: 'SQL INSERT', icon: <ClipboardCopy />, onSelect: copy('sql', 'SQL') }
  )
  showMenuAt(anchor, items)
}

type View = number | 'messages' | 'plan' | 'compare' | `pin:${string}`

function TabButton({
  active,
  onClick,
  className,
  children,
  onClose,
  title
}: {
  active: boolean
  onClick: () => void
  className?: string
  children: React.ReactNode
  onClose?: () => void
  title?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={cn(
        'group relative flex shrink-0 items-center gap-1.5 px-3 text-[12px]',
        active ? 'text-bright' : 'text-muted hover:text-fg',
        className
      )}
    >
      {active && <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-accent" />}
      {children}
      {onClose && (
        <span
          role="button"
          tabIndex={-1}
          title="Close"
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
          className="-mr-1 rounded p-0.5 text-faint opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-bright"
        >
          <X className="size-3" />
        </span>
      )}
    </button>
  )
}

export function ResultsPanel({
  result,
  running,
  startedAt,
  dialect,
  tabId,
  onJumpToError,
  emptyHint,
  loadMore,
  exportFull,
  edit
}: {
  result?: RunResult
  running: boolean
  startedAt?: number
  dialect: Dialect
  /** The query tab, for remembered column layouts and pinned results */
  tabId?: string
  onJumpToError?: () => void
  emptyHint?: React.ReactNode
  /** Fetch more rows of a cut-off result by running the text again with a higher limit */
  loadMore?: { run: (set: number) => void; disabled?: string }
  /** Stream every row of a result set to a file */
  exportFull?: { run: (set: number, format: StreamFormat) => void; disabled?: string }
  /** Set when the first result set comes straight from one table with a primary key */
  edit?: ResultEditTarget
}): React.JSX.Element {
  const output = result?.output
  const sets = useMemo(() => output?.results ?? [], [output])
  const pins = pinnedResultsStore.use()[tabId ?? ''] ?? []
  const [active, setActive] = useState<View>(0)
  const [filter, setFilter] = useState('')
  const [showFilter, setShowFilter] = useState(false)
  const [columnFilters, setColumnFilters] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [compareWith, setCompareWith] = useState<string | null>(null)
  const [compareKey, setCompareKey] = useState('')
  const [editPanel, setEditPanel] = useState(false)
  // The result set compared and edited: the one last shown, else the first
  const lastSet = useRef(0)
  if (typeof active === 'number') lastSet.current = active

  // Jump to messages when a run produced no grids or failed outright
  useEffect(() => {
    if (!result) return
    if (result.keepView) {
      setActive((a) => (typeof a === 'number' && a >= sets.length ? 0 : a))
      return
    }
    setActive(
      result.plan ? 'plan' : sets.length && !(output?.error && !sets.length) ? 0 : 'messages'
    )
    setFilter('')
    // A new run starts with nothing pending, so the panel can wait for the first edit
    setEditPanel(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result])

  useEffect(() => {
    if (!running || !startedAt) return
    const timer = setInterval(() => setElapsed(Date.now() - startedAt), 100)
    return () => clearInterval(timer)
  }, [running, startedAt])

  useEffect(() => () => selectionSummaryStore.set(null), [])

  const set = typeof active === 'number' ? sets[active] : undefined
  const pinned =
    typeof active === 'string' && active.startsWith('pin:')
      ? pins.find((p) => `pin:${p.id}` === active)
      : undefined
  const comparePin = pins.find((p) => p.id === compareWith)
  const compareSet = sets[lastSet.current] ?? sets[0]
  const editable = !!edit && active === 0 && sets.length > 0
  const errorCount =
    output?.messages.filter((m) => m.level === 'error').length ?? (result?.error ? 1 : 0)

  const setPins = (update: (list: PinnedResult[]) => PinnedResult[]): void => {
    if (!tabId) return
    pinnedResultsStore.set((all) => ({ ...all, [tabId]: update(all[tabId] ?? []) }))
  }
  const pin = (s: ResultSet, index: number): void => {
    const id = crypto.randomUUID()
    const time = new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    setPins((list) => [
      ...list,
      {
        id,
        label: `${sets.length > 1 ? `Result ${index + 1}` : 'Result'} · ${time}`,
        columns: s.columns,
        rows: s.rows,
        rowCount: s.rowCount,
        truncated: s.truncated,
        sql: result?.sql ?? '',
        at: Date.now()
      }
    ])
    setActive(`pin:${id}`)
  }
  const unpin = (id: string): void => {
    setPins((list) => list.filter((p) => p.id !== id))
    if (compareWith === id) setCompareWith(null)
    if (active === `pin:${id}` || (active === 'compare' && compareWith === id)) setActive(0)
  }
  const startCompare = (id: string): void => {
    setCompareWith(id)
    setActive('compare')
  }

  const diff = useMemo(
    () =>
      active === 'compare' && comparePin && compareSet
        ? diffResults(comparePin, compareSet, compareKey ? [compareKey] : [])
        : null,
    [active, comparePin, compareSet, compareKey]
  )
  const diffMarks = useMemo<GridMarks | undefined>(
    () =>
      diff
        ? {
            rowStatus: (r) =>
              diff.status[r] === 'added'
                ? 'inserted'
                : diff.status[r] === 'removed'
                  ? 'deleted'
                  : diff.status[r],
            isModified: (r, c) => diff.changed.has(`${r}:${c}`)
          }
        : undefined,
    [diff]
  )

  const fullExport = (index: number): Parameters<typeof exportMenu>[5] =>
    exportFull && {
      run: (format) => exportFull.run(index, format),
      disabled: exportFull.disabled
    }

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      <div className="flex h-8 shrink-0 items-stretch border-b border-line bg-panel">
        <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto [&::-webkit-scrollbar]:h-0">
          {result?.plan && (
            <TabButton active={active === 'plan'} onClick={() => setActive('plan')}>
              <Workflow className="size-3.5" />
              Plan
              {result.plan.hints.length > 0 && (
                <span className="text-warn tabular-nums">{result.plan.hints.length}</span>
              )}
            </TabButton>
          )}
          {sets.map((s, i) => (
            <TabButton key={i} active={active === i} onClick={() => setActive(i)}>
              {i === 0 && edit ? (
                <Pencil className="size-3.5 text-accent" />
              ) : (
                <TableProperties className="size-3.5" />
              )}
              Result {sets.length > 1 ? i + 1 : ''}
              <span className="text-faint tabular-nums">{s.rowCount.toLocaleString()}</span>
            </TabButton>
          ))}
          <TabButton
            active={active === 'messages'}
            onClick={() => setActive('messages')}
            className={cn(errorCount > 0 && 'text-danger')}
          >
            {errorCount > 0 ? (
              <AlertTriangle className="size-3.5" />
            ) : (
              <MessageSquareText className="size-3.5" />
            )}
            Messages
            {(output?.messages.length ?? 0) > 0 && (
              <span className="text-faint tabular-nums">{output?.messages.length}</span>
            )}
          </TabButton>
          {pins.map((p) => (
            <TabButton
              key={p.id}
              active={active === `pin:${p.id}`}
              onClick={() => setActive(`pin:${p.id}`)}
              onClose={() => unpin(p.id)}
              title={p.sql}
            >
              <Pin className="size-3.5 text-accent" />
              {p.label}
              <span className="text-faint tabular-nums">{p.rowCount.toLocaleString()}</span>
            </TabButton>
          ))}
          {comparePin && (
            <TabButton
              active={active === 'compare'}
              onClick={() => setActive('compare')}
              onClose={() => {
                setCompareWith(null)
                if (active === 'compare') setActive(0)
              }}
            >
              <GitCompareArrows className="size-3.5" />
              Compare
            </TabButton>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1 pr-1.5 text-[11px] text-muted">
          {running ? (
            <span className="px-2 text-accent tabular-nums">{formatDuration(elapsed)}</span>
          ) : (
            output && (
              <span className="px-2 tabular-nums">
                {output.cancelled ? 'cancelled · ' : ''}
                {formatDuration(output.elapsedMs)}
              </span>
            )
          )}
          {set && typeof active === 'number' && (
            <>
              {set.truncated && (
                <span
                  className="flex items-center gap-1 px-1 text-warn"
                  title={`${set.rowCount.toLocaleString()} rows in all. Raise the row limit in Settings, load more, or export the full result.`}
                >
                  <AlertTriangle className="size-3" /> first {plural(set.rows.length, 'row')}
                </span>
              )}
              {set.truncated && loadMore && (
                <Button
                  size="xs"
                  variant="secondary"
                  disabled={running || !!loadMore.disabled}
                  title={
                    loadMore.disabled ??
                    'Runs the query again with a higher row limit; rows already shown stay in place'
                  }
                  onClick={() => loadMore.run(active)}
                >
                  <Plus className="size-3" /> Load more
                </Button>
              )}
              {editable && edit && (
                <EditButtons
                  edit={edit}
                  pendingKey={tabId ?? ''}
                  open={editPanel}
                  onToggle={() => setEditPanel((o) => !o)}
                />
              )}
              <FilterBox
                show={showFilter}
                value={filter}
                onShow={setShowFilter}
                onChange={setFilter}
              />
              <Button
                size="icon-sm"
                variant="ghost"
                title={columnFilters ? 'Hide column filters' : 'Filter by column'}
                className={cn(columnFilters && 'bg-hover text-bright')}
                onClick={() => setColumnFilters((o) => !o)}
              >
                <ListFilter className="size-3.5" />
              </Button>
              {tabId && (
                <Button
                  size="icon-sm"
                  variant="ghost"
                  title="Pin this result so later runs don't replace it"
                  onClick={() => pin(set, active)}
                >
                  <Pin className="size-3.5" />
                </Button>
              )}
              <Button
                size="xs"
                variant="ghost"
                onClick={(e) =>
                  exportMenu(
                    e.currentTarget,
                    set,
                    `result-${active + 1}`,
                    dialect,
                    edit && active === 0 ? qualified(dialect, edit.tableRef) : undefined,
                    fullExport(active)
                  )
                }
              >
                <Download className="size-3.5" /> Export <ChevronDown className="size-3" />
              </Button>
            </>
          )}
          {pinned && (
            <>
              <Button
                size="xs"
                variant="secondary"
                disabled={!compareSet}
                title="Compare this pinned result with the latest run"
                onClick={() => startCompare(pinned.id)}
              >
                <GitCompareArrows className="size-3.5" /> Compare with latest
              </Button>
              <Button size="icon-sm" variant="ghost" title="Unpin" onClick={() => unpin(pinned.id)}>
                <PinOff className="size-3.5" />
              </Button>
              <Button
                size="xs"
                variant="ghost"
                onClick={(e) => exportMenu(e.currentTarget, pinned, 'pinned-result', dialect)}
              >
                <Download className="size-3.5" /> <ChevronDown className="size-3" />
              </Button>
            </>
          )}
          {active === 'compare' && diff && comparePin && (
            <>
              <span className="flex items-center gap-2 px-1 tabular-nums">
                <span className="text-ok">+{diff.counts.added}</span>
                <span className="text-danger">−{diff.counts.removed}</span>
                {compareKey && <span className="text-warn">~{diff.counts.changed}</span>}
                <span className="text-faint">{diff.counts.same} same</span>
              </span>
              <Select
                value={compareKey}
                onChange={(e) => setCompareKey(e.target.value)}
                className="h-6 w-40 text-[11px]"
                title="Rows with the same key are compared cell by cell"
              >
                <option value="">Match whole rows</option>
                {diff.columns.map((c) => (
                  <option key={c.name} value={c.name}>
                    Match by {c.name}
                  </option>
                ))}
              </Select>
            </>
          )}
        </div>
      </div>
      <ProgressBar active={running} />
      <div
        className="min-h-0 flex-1"
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && set) {
            e.preventDefault()
            setShowFilter(true)
          }
        }}
      >
        {active === 'plan' && result?.plan ? (
          <PlanView plan={result.plan} />
        ) : active === 'messages' ? (
          <Messages result={result} onJumpToError={onJumpToError} />
        ) : pinned ? (
          <ResultGrid
            columns={pinned.columns}
            rows={pinned.rows}
            filter={filter}
            columnFilters={columnFilters}
            onColumnFiltersChange={setColumnFilters}
            layoutKey={tabId && `query:${tabId}`}
            dialect={dialect}
            onSelectionSummary={selectionSummaryStore.set}
          />
        ) : active === 'compare' && diff ? (
          <ResultGrid
            columns={diff.columns}
            rows={diff.rows}
            marks={diffMarks}
            dialect={dialect}
            onSelectionSummary={selectionSummaryStore.set}
          />
        ) : set ? (
          !set.columns.length ? (
            <EmptyState title="No columns" />
          ) : editable && edit ? (
            <EditableResult
              key={qualified(dialect, edit.tableRef)}
              set={set}
              edit={edit}
              dialect={dialect}
              filter={filter}
              columnFilters={columnFilters}
              onColumnFiltersChange={setColumnFilters}
              layoutKey={tabId && `query:${tabId}`}
              pendingKey={tabId ?? ''}
              panelOpen={editPanel}
              onPanelOpen={setEditPanel}
            />
          ) : (
            <ResultGrid
              columns={set.columns}
              rows={set.rows}
              filter={filter}
              columnFilters={columnFilters}
              onColumnFiltersChange={setColumnFilters}
              layoutKey={tabId && `query:${tabId}`}
              dialect={dialect}
              onSelectionSummary={selectionSummaryStore.set}
            />
          )
        ) : running ? (
          <EmptyState title="Running…" />
        ) : (
          (emptyHint ?? <EmptyState title="Run a query to see results" />)
        )}
      </div>
    </div>
  )
}

function FilterBox({
  show,
  value,
  onShow,
  onChange
}: {
  show: boolean
  value: string
  onShow: (show: boolean) => void
  onChange: (value: string) => void
}): React.JSX.Element {
  if (!show)
    return (
      <Button
        size="icon-sm"
        variant="ghost"
        title="Filter rows (Ctrl+F in grid)"
        onClick={() => onShow(true)}
      >
        <Search className="size-3.5" />
      </Button>
    )
  const close = (): void => {
    onChange('')
    onShow(false)
  }
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute top-1/2 left-1.5 size-3 -translate-y-1/2 text-faint" />
      <input
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') close()
        }}
        placeholder="Filter rows"
        className="h-6 w-44 rounded border border-line-strong bg-canvas pr-6 pl-6 text-[11.5px] text-bright placeholder:text-faint focus:border-accent/50 focus:outline-none"
      />
      <button
        className="absolute top-1/2 right-1 -translate-y-1/2 text-faint hover:text-bright"
        onClick={close}
      >
        <X className="size-3" />
      </button>
    </div>
  )
}

/** Pending changes per query tab, counted by EditableResult for the toolbar */
const pendingCountStore = createStore<Record<string, number>>({})

function EditButtons({
  edit,
  pendingKey,
  open,
  onToggle
}: {
  edit: ResultEditTarget
  pendingKey: string
  open: boolean
  onToggle: () => void
}): React.JSX.Element {
  const count = pendingCountStore.use()[pendingKey] ?? 0
  const table = [edit.tableRef.schema, edit.tableRef.name].filter(Boolean).join('.')
  return (
    <Button
      size="xs"
      variant="ghost"
      onClick={onToggle}
      className={cn(open && 'bg-hover text-bright')}
      title={`Rows come from ${table}: double-click a cell to edit. Changes wait in Pending until committed.`}
    >
      <ListChecks className="size-3.5" /> Pending
      {count > 0 && <Badge tone="accent">{count}</Badge>}
    </Button>
  )
}

/** The first result set, editable through the table tab's pending-changes flow. */
function EditableResult({
  set,
  edit,
  dialect,
  filter,
  columnFilters,
  onColumnFiltersChange,
  layoutKey,
  pendingKey,
  panelOpen,
  onPanelOpen
}: {
  set: ResultSet
  edit: ResultEditTarget
  dialect: Dialect
  filter: string
  columnFilters: boolean
  onColumnFiltersChange: (open: boolean) => void
  layoutKey?: string
  pendingKey: string
  panelOpen: boolean
  onPanelOpen: (open: boolean) => void
}): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const { changes, setChanges, rows, editing, visibleKeys } = usePendingEdits({
    columns: set.columns,
    baseRows: set.rows,
    primaryKey: edit.info.primaryKey,
    enabled: true,
    readOnlyColumns: edit.readOnly
  })

  useEffect(() => {
    pendingCountStore.set((all) => ({ ...all, [pendingKey]: changes.length }))
  }, [changes.length, pendingKey])
  useEffect(
    () => () =>
      pendingCountStore.set((all) => {
        const next = { ...all }
        delete next[pendingKey]
        return next
      }),
    [pendingKey]
  )

  // Open the panel when the first change is made
  const hadChanges = useRef(false)
  useEffect(() => {
    if (changes.length && !hadChanges.current) onPanelOpen(true)
    hadChanges.current = changes.length > 0
  }, [changes.length, onPanelOpen])

  const commit = async (ids?: string[]): Promise<void> => {
    if (edit.blocked) return
    const subset = ids ? changes.filter((c) => ids.includes(c.id)) : changes
    const done = new Set(subset.map((c) => c.id))
    const ok = await commitPendingChanges({
      changes: subset,
      dialect,
      tableRef: edit.tableRef,
      info: edit.info,
      confirmDangerous: edit.confirmDangerous,
      connection: edit.connection,
      execute: (sql, options) => edit.execute(sql, options),
      busy: setBusy
    })
    if (!ok) return
    setChanges((all) => all.filter((c) => !done.has(c.id)))
    edit.onCommitted()
  }

  const readOnlyNames = useMemo(
    () =>
      new Set([
        ...edit.info.columns.filter((c) => c.isGenerated).map((c) => c.name),
        ...set.columns.filter((_, i) => edit.readOnly.has(i)).map((c) => c.name)
      ]),
    [edit.info, edit.readOnly, set.columns]
  )

  return (
    <div className="flex h-full min-h-0">
      <div className="min-w-0 flex-1">
        <ResultGrid
          columns={set.columns}
          rows={rows}
          editing={editing}
          filter={filter}
          columnFilters={columnFilters}
          onColumnFiltersChange={onColumnFiltersChange}
          layoutKey={layoutKey}
          dialect={dialect}
          tableName={qualified(dialect, edit.tableRef)}
          onLoadValue={(row, col) =>
            fetchCellValue({
              execute: (sql, options) => edit.execute(sql, options),
              dialect,
              tableRef: edit.tableRef,
              info: edit.info,
              columns: set.columns,
              row: set.rows[row],
              column: col
            })
          }
          onSelectionSummary={selectionSummaryStore.set}
        />
      </div>
      {panelOpen && (
        <ChangesPanel
          changes={changes}
          columns={set.columns}
          primaryKey={edit.info.primaryKey}
          info={edit.info}
          dialect={dialect}
          tableRef={edit.tableRef}
          visibleKeys={visibleKeys}
          readOnlyColumns={readOnlyNames}
          busy={busy || !!edit.blocked}
          onChange={setChanges}
          onCommit={(ids) => void commit(ids)}
          onCancelAll={() => setChanges([])}
          onClose={() => onPanelOpen(false)}
          onAddRow={() => setChanges(addInsert)}
          notice={edit.blocked}
        />
      )}
    </div>
  )
}

function Messages({
  result,
  onJumpToError
}: {
  result?: RunResult
  onJumpToError?: () => void
}): React.JSX.Element {
  if (!result) return <EmptyState title="No messages yet" />
  const messages = result.output?.messages ?? []
  return (
    <div className="h-full overflow-auto p-3 font-mono text-[12px] leading-relaxed select-text">
      {result.error && <p className="whitespace-pre-wrap text-danger">{result.error}</p>}
      {messages.map((m, i) => (
        <div
          key={i}
          className={cn(
            'flex gap-3 border-b border-line/50 py-1 last:border-0',
            m.level === 'error' && 'text-danger',
            m.level === 'warning' && 'text-warn',
            (m.level === 'notice' || m.level === 'info') && 'text-info',
            m.level === 'rows' && 'text-fg'
          )}
        >
          <span className="w-14 shrink-0 text-right text-faint tabular-nums">
            {formatDuration(m.atMs)}
          </span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap">{m.text}</span>
        </div>
      ))}
      {result.output?.error &&
        onJumpToError &&
        (result.output.error.position != null || result.output.error.line != null) && (
          <button className="mt-2 font-sans text-xs text-accent underline" onClick={onJumpToError}>
            Show error in editor
          </button>
        )}
      {result.output && !result.output.error && !result.error && (
        <p className="mt-2 text-ok">
          Completed in {formatDuration(result.output.elapsedMs)}
          {result.output.cancelled ? ' (cancelled)' : ''}
        </p>
      )}
    </div>
  )
}
