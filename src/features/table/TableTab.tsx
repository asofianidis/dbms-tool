import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ChevronDown,
  Pencil,
  Play,
  ChevronLeft,
  ChevronRight,
  ClipboardCopy,
  Download,
  FilePlus2,
  Hash,
  KeyRound,
  Link2,
  ListChecks,
  Lock,
  Plus,
  RefreshCw,
  Zap
} from 'lucide-react'
import {
  api,
  type Cell,
  type ColumnMeta,
  type DbObject,
  type Engine,
  type ExecOutput,
  type ForeignKeyInfo,
  type TableInfo,
  type TriggerInfo
} from '@/lib/api'
import { modifyScript } from '@/lib/routines'
import { cn } from '@/lib/cn'
import { ENGINES, type Dialect } from '@/lib/engines'
import { copyText, EXPORT_MAX_ROWS, type FetchedRows } from '@/lib/export'
import {
  buildOrderBy,
  buildWhere,
  emptyQuery,
  newCondition,
  type FilterCondition,
  type QueryState
} from '@/lib/filters'
import { formatDuration, plural } from '@/lib/format'
import {
  addInsert,
  deleteRow,
  editInsert,
  editRow,
  removeChange,
  rowKeyOf,
  toRowEdits,
  type PendingChange
} from '@/lib/pending'
import { queries } from '@/lib/queries'
import { canHaveTriggers } from '@/lib/triggers'
import { settingsStore } from '@/lib/settings'
import {
  countRows,
  editStatements,
  qualified,
  quoteIdent,
  scriptCreateTable,
  selectRows,
  wrapInTransaction,
  type TableRef
} from '@/lib/sql'
import { errorMessage, toast, toastError } from '@/lib/toast'
import {
  confirm,
  connect,
  connectionsStore,
  newQueryTab,
  openTable,
  setRunning,
  statusStore,
  updateTab,
  type TabOf,
  type TableView
} from '@/lib/workspace'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { ResultGrid, type SortState } from '@/components/grid/ResultGrid'
import type { MenuItem } from '@/components/ContextMenu'
import {
  Badge,
  Button,
  EmptyState,
  ErrorText,
  ProgressBar,
  Segmented,
  Spinner,
  Toolbar,
  ToolbarDivider
} from '@/components/ui'
import { selectionSummaryStore } from '@/components/shell/StatusBar'
import { exportMenu } from '../query/ResultsPanel'
import { openExecuteRoutine } from '../explorer/ExecuteRoutineDialog'
import { ChangesPanel } from './ChangesPanel'
import { QueryBuilder, QuerySummary } from './QueryBuilder'
import { openTableDesigner } from './TableDesigner'
import { openTriggerDesigner } from './TriggerDesigner'

/** Where a foreign key points. MySQL reports the referenced database as its schema. */
function fkTarget(
  engine: Engine | undefined,
  tab: TabOf<'table'>,
  fk: ForeignKeyInfo
): { database: string; schema: string | null } {
  return engine === 'mysql'
    ? { database: fk.refSchema ?? tab.database, schema: null }
    : { database: tab.database, schema: fk.refSchema }
}

/** A filter condition matching a cell value exactly. */
function valueCondition(column: string, value: Cell): FilterCondition {
  return value === null
    ? newCondition({ column, op: 'null' })
    : typeof value === 'boolean'
      ? newCondition({ column, op: value ? 'true' : 'false' })
      : newCondition({ column, op: 'eq', value })
}

export function TableTab({ tab }: { tab: TabOf<'table'> }): React.JSX.Element {
  const connections = connectionsStore.use()
  const statuses = statusStore.use()
  const connection = connections.find((c) => c.id === tab.connectionId)
  const connected = statuses[tab.connectionId]?.state === 'connected'
  const dialect: Dialect = (connection && ENGINES[connection.engine].dialect) || 'postgres'
  const ref: TableRef =
    connection?.engine === 'mysql'
      ? { schema: tab.database, name: tab.name }
      : { schema: tab.schema, name: tab.name }
  const browsable = ['table', 'view', 'materialized_view', 'foreign_table'].includes(tab.objectKind)

  useEffect(() => {
    if (!connected && connection) void connect(connection.id)
  }, [connected, connection])

  const views: { value: TableView; label: string }[] = browsable
    ? [
        { value: 'data', label: 'Data' },
        { value: 'structure', label: 'Structure' },
        { value: 'definition', label: tab.objectKind === 'table' ? 'DDL' : 'Definition' }
      ]
    : [{ value: 'definition', label: 'Definition' }]

  if (!connection) return <EmptyState title="This connection no longer exists" />

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-3 border-b border-line bg-panel px-3">
        <span className="min-w-0 truncate font-mono text-[12.5px] text-bright">
          <span className="text-muted">{tab.database}.</span>
          {tab.schema && connection.engine !== 'mysql' && (
            <span className="text-muted">{tab.schema}.</span>
          )}
          {tab.name}
          {tab.detail != null && <span className="text-faint">({tab.detail})</span>}
        </span>
        <Badge>{tab.objectKind.replace('_', ' ')}</Badge>
        {connection.readOnly && (
          <Badge tone="warning">
            <Lock className="size-3" /> read-only
          </Badge>
        )}
        <div className="flex-1" />
        {views.length > 1 && (
          <Segmented
            value={tab.view}
            options={views}
            onChange={(view) => updateTab(tab.id, { view })}
          />
        )}
      </div>
      {!connected ? (
        <EmptyState title="Connecting…" icon={<Spinner className="size-5" />} />
      ) : tab.view === 'data' && browsable ? (
        <DataView
          tab={tab}
          engine={connection.engine}
          dialect={dialect}
          tableRef={ref}
          readOnly={connection.readOnly || tab.objectKind !== 'table'}
        />
      ) : tab.view === 'structure' && browsable ? (
        <StructureView tab={tab} engine={connection.engine} dialect={dialect} />
      ) : (
        <DefinitionView tab={tab} dialect={dialect} tableRef={ref} />
      )}
    </div>
  )
}

function DataView({
  tab,
  engine,
  dialect,
  tableRef,
  readOnly
}: {
  tab: TabOf<'table'>
  engine: Engine
  dialect: Dialect
  tableRef: TableRef
  readOnly: boolean
}): React.JSX.Element {
  const { pageSize, confirmDangerous } = settingsStore.use()
  const info = useQuery(queries.table(tab.connectionId, tab.database, tab.schema, tab.name))
  const [query, setQuery] = useState<QueryState>(() => tab.query ?? emptyQuery())
  const [builderOpen, setBuilderOpen] = useState(false)
  const [page, setPage] = useState(0)
  const [output, setOutput] = useState<ExecOutput | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [total, setTotal] = useState<number | null>(null)
  const [changes, setChanges] = useState<PendingChange[]>([])
  const [panelOpen, setPanelOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [exporting, setExporting] = useState(false)

  const set = output?.results[0]
  const columns: ColumnMeta[] = set?.columns ?? []
  const pk = info.data?.primaryKey ?? []
  const canEdit = !readOnly && pk.length > 0 && !!info.data
  const appliedWhere = useMemo(
    () =>
      buildWhere(
        dialect,
        query,
        Object.fromEntries((info.data?.columns ?? []).map((c) => [c.name, c.dataType]))
      ),
    [dialect, query, info.data]
  )
  const appliedOrder = useMemo(() => buildOrderBy(dialect, query.sorts), [dialect, query.sorts])
  // Default to primary-key order so rows don't move around after an edit
  const orderBy =
    appliedOrder || (pk.length ? pk.map((k) => quoteIdent(dialect, k)).join(', ') : undefined)

  /** Applies a new filter / sort from the builder, chips or grid header. */
  const applyQuery = (next: QueryState): void => {
    setQuery(next)
    setPage(0)
    setTotal(null)
  }

  // Apply a filter handed to an already open tab, e.g. by following a foreign key
  const requested = useRef(tab.query)
  useEffect(() => {
    if (!tab.query || tab.query === requested.current) return
    requested.current = tab.query
    applyQuery(tab.query)
  }, [tab.query])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    setRunning(tab.id, true)
    try {
      // One row past the page tells whether there's a next page
      const sql = selectRows(dialect, tableRef, {
        where: appliedWhere,
        orderBy,
        limit: pageSize + 1,
        offset: page * pageSize,
        keyColumns: pk
      })
      const out = await api.execute(tab.connectionId, tab.id, tab.database, sql, {
        maxRows: pageSize + 1
      })
      // Pending changes are keyed by primary key, so they survive reloads and paging
      if (out.error) setError(out.error.message)
      else setOutput(out)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setLoading(false)
      setRunning(tab.id, false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    tab.connectionId,
    tab.id,
    tab.database,
    dialect,
    appliedWhere,
    appliedOrder,
    page,
    pageSize,
    pk.join(',')
  ])

  useEffect(() => {
    if (info.isPending) return
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedWhere, appliedOrder, page, pageSize, info.isPending])

  const count = async (): Promise<void> => {
    try {
      const out = await api.execute(
        tab.connectionId,
        tab.id,
        tab.database,
        countRows(dialect, tableRef, appliedWhere)
      )
      if (out.error) throw new Error(out.error.message)
      setTotal(Number(out.results[0]?.rows[0]?.[0] ?? 0))
    } catch (e) {
      toastError(e)
    }
  }

  // The page shown, without the extra row fetched to detect a next page
  const baseRows = useMemo(() => set?.rows.slice(0, pageSize) ?? [], [set, pageSize])
  // The loaded rows as records, with the primary key that ties them to pending changes
  const baseRecords = useMemo(
    () =>
      baseRows.map((r) => {
        const record = Object.fromEntries(columns.map((c, i) => [c.name, r[i]]))
        return { record, key: rowKeyOf(pk, record) }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [baseRows, columns, pk.join(',')]
  )
  const byKey = useMemo(
    () => new Map(changes.filter((c) => c.rowKey).map((c) => [c.rowKey!, c])),
    [changes]
  )
  const inserts = useMemo(() => changes.filter((c) => c.kind === 'insert'), [changes])
  const rows = useMemo(
    () => [
      ...baseRows.map((r, i) => {
        const change = byKey.get(baseRecords[i].key)
        if (change?.kind !== 'update') return r
        return columns.map((c, ci) => (c.name in change.values ? change.values[c.name] : r[ci]))
      }),
      ...inserts.map((c) => columns.map((col) => c.values[col.name] ?? null))
    ],
    [baseRows, baseRecords, byKey, inserts, columns]
  )

  // Open the panel when the first change is made
  const hadChanges = useRef(false)
  useEffect(() => {
    if (changes.length && !hadChanges.current) setPanelOpen(true)
    hadChanges.current = changes.length > 0
  }, [changes.length])

  const generatedColumns = useMemo(() => {
    const generated = new Set<number>()
    columns.forEach((c, i) => {
      if (info.data?.columns.find((col) => col.name === c.name)?.isGenerated) generated.add(i)
    })
    return generated
  }, [columns, info.data])

  /** Commits the given pending changes (all by default) in one transaction. */
  const commit = async (ids?: string[]): Promise<void> => {
    if (!info.data) return
    const subset = ids ? changes.filter((c) => ids.includes(c.id)) : changes
    const statements = editStatements(dialect, tableRef, info.data, toRowEdits(subset))
    const done = new Set(subset.map((c) => c.id))
    if (!statements.length) return setChanges((all) => all.filter((c) => !done.has(c.id)))
    const script = wrapInTransaction(dialect, statements)
    const deletes = subset.some((c) => c.kind === 'delete')
    if (confirmDangerous || deletes) {
      const ok = await confirm({
        title: `Commit ${plural(statements.length, 'change')}?`,
        message: 'These statements run in one transaction; if any fails, none are applied.',
        code: script,
        confirmLabel: 'Commit',
        danger: deletes
      })
      if (!ok) return
    }
    setLoading(true)
    try {
      const out = await api.execute(tab.connectionId, tab.id, tab.database, script)
      if (out.error) {
        await api
          .execute(
            tab.connectionId,
            tab.id,
            tab.database,
            dialect === 'tsql' ? 'IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION' : 'ROLLBACK'
          )
          .catch(() => {})
        toast(`Changes not committed: ${out.error.message}`, 'error')
      } else {
        // Functional update keeps changes edited while the commit ran
        setChanges((all) => all.filter((c) => !done.has(c.id)))
        toast(`Committed ${plural(statements.length, 'change')}`)
        await load()
      }
    } catch (e) {
      toastError(e)
    } finally {
      setLoading(false)
    }
  }

  const insertAt = (row: number): PendingChange | undefined => inserts[row - baseRows.length]
  const editing = canEdit
    ? {
        onEdit: (row: number, col: number, value: Cell) =>
          setChanges((all) =>
            row >= baseRows.length
              ? editInsert(all, insertAt(row)!.id, columns[col].name, value)
              : editRow(all, pk, baseRecords[row].record, columns[col].name, value)
          ),
        rowStatus: (row: number) =>
          row >= baseRows.length
            ? ('inserted' as const)
            : byKey.get(baseRecords[row].key)?.kind === 'delete'
              ? ('deleted' as const)
              : undefined,
        isModified: (row: number, col: number) => {
          const change = row < baseRows.length ? byKey.get(baseRecords[row].key) : undefined
          return change?.kind === 'update' && columns[col].name in change.values
        },
        onDeleteRows: (list: number[]) =>
          setChanges((all) =>
            list.reduce(
              // Deleting a new row just drops it
              (acc, row) =>
                row >= baseRows.length
                  ? removeChange(acc, insertAt(row)!.id)
                  : deleteRow(acc, pk, baseRecords[row].record),
              all
            )
          ),
        onRevertRows: (list: number[]) => {
          const keys = new Set(
            list.filter((r) => r < baseRows.length).map((r) => baseRecords[r].key)
          )
          setChanges((all) => all.filter((c) => !c.rowKey || !keys.has(c.rowKey)))
        },
        readOnlyColumns: generatedColumns
      }
    : undefined

  const filterByValue = (column: string, value: Cell): void => {
    const condition = valueCondition(column, value)
    // Narrow the current filter. With "any", fold the existing conditions into one OR group first
    const orGroup = query.match === 'any' && query.conditions.filter((c) => c.enabled).length > 1
    applyQuery({
      ...query,
      match: 'all',
      conditions: orGroup
        ? [newCondition({ kind: 'sql', sql: appliedWhere }), condition]
        : [...query.conditions, condition]
    })
  }

  // Foreign key columns link to the row they reference
  const referenceItems = (row: number, col: number): MenuItem[] =>
    (info.data?.foreignKeys ?? [])
      .filter((fk) => fk.columns.includes(columns[col].name))
      .map((fk) => {
        const values = fk.columns.map((name) => {
          const i = columns.findIndex((c) => c.name === name)
          return i < 0 ? null : rows[row][i]
        })
        const target = fkTarget(engine, tab, fk)
        return {
          label: `Go to ${fk.refTable} record`,
          icon: <Link2 />,
          disabled: values.some((v) => v === null),
          onSelect: () =>
            openTable(
              tab.connectionId,
              target.database,
              target.schema,
              fk.refTable,
              'table',
              'data',
              null,
              {
                ...emptyQuery(),
                conditions: fk.refColumns.map((c, i) => valueCondition(c, values[i]))
              }
            )
        }
      })

  // The grid header shows and sets the first sort column
  const firstSort = query.sorts[0]
  const gridSort: SortState =
    firstSort && columns.some((c) => c.name === firstSort.column)
      ? { col: columns.findIndex((c) => c.name === firstSort.column), dir: firstSort.dir }
      : null

  const from = page * pageSize
  const hasNext = (set?.rows.length ?? 0) > pageSize

  /** Every row matching the filter, in the same order, for "Save as". */
  const fetchAllRows = async (): Promise<FetchedRows> => {
    // A separate session leaves the tab free to page and commit during a long fetch
    const session = `${tab.id}:export`
    setExporting(true)
    try {
      const sql = selectRows(dialect, tableRef, {
        where: appliedWhere,
        orderBy,
        limit: EXPORT_MAX_ROWS + 1,
        keyColumns: pk
      })
      const out = await api.execute(tab.connectionId, session, tab.database, sql, {
        maxRows: EXPORT_MAX_ROWS,
        readOnly: true
      })
      if (out.error) throw new Error(out.error.message)
      if (out.cancelled) throw new Error('The fetch was cancelled.')
      const all = out.results[0]
      if (!all) throw new Error('The query returned no rows.')
      return { columns: all.columns, rows: all.rows, truncated: all.truncated }
    } finally {
      void api.closeSession(tab.connectionId, session).catch(() => {})
      setExporting(false)
    }
  }

  return (
    <>
      <Toolbar className="gap-2">
        <QuerySummary
          query={query}
          open={builderOpen}
          onToggle={() => setBuilderOpen((o) => !o)}
          onChange={applyQuery}
        />
        <Button
          size="icon"
          variant="ghost"
          title="Reload"
          onClick={() => void load()}
          disabled={loading}
        >
          <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
        </Button>
        <ToolbarDivider />
        <div className="flex items-center gap-0.5 text-[11.5px] text-muted">
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={page === 0 || loading}
            onClick={() => setPage((p) => p - 1)}
            title="Previous page"
          >
            <ChevronLeft className="size-3.5" />
          </Button>
          <span className="px-1 tabular-nums">
            {set
              ? `${(from + (baseRows.length ? 1 : 0)).toLocaleString()}–${(from + baseRows.length).toLocaleString()}`
              : '—'}
          </span>
          <Button
            size="icon-sm"
            variant="ghost"
            disabled={!hasNext || loading}
            onClick={() => setPage((p) => p + 1)}
            title="Next page"
          >
            <ChevronRight className="size-3.5" />
          </Button>
          <button
            className="ml-1 flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-hover hover:text-bright"
            onClick={() => void count()}
            title="Count matching rows"
          >
            <Hash className="size-3" />
            {total != null ? `of ${total.toLocaleString()}` : 'Count'}
          </button>
        </div>
        <ToolbarDivider />
        {canEdit ? (
          <>
            <Button size="sm" variant="ghost" onClick={() => setChanges(addInsert)} title="Add row">
              <Plus className="size-3.5" /> Row
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setPanelOpen((o) => !o)}
              title={panelOpen ? 'Hide pending changes' : 'Show pending changes'}
              className={cn(panelOpen && 'bg-hover text-bright')}
            >
              <ListChecks className="size-3.5" /> Pending
              {changes.length > 0 && <Badge tone="accent">{changes.length}</Badge>}
            </Button>
          </>
        ) : (
          !readOnly &&
          info.data &&
          pk.length === 0 && (
            <span
              className="text-[11px] text-faint"
              title="Rows can only be edited when the table has a primary key"
            >
              No primary key · read-only
            </span>
          )
        )}
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter page"
          spellCheck={false}
          className="h-7 w-32 rounded-md border border-line-strong bg-canvas px-2 text-[12px] text-bright placeholder:text-faint focus:border-accent/50 focus:outline-none"
        />
        {set && (
          <Button
            size="xs"
            variant="ghost"
            disabled={exporting}
            onClick={(e) =>
              exportMenu(
                e.currentTarget,
                { columns, rows },
                tab.name,
                dialect,
                qualified(dialect, tableRef),
                // A single complete page saves what's shown, pending edits included
                { partial: page > 0 || hasNext, fetch: fetchAllRows }
              )
            }
          >
            <Download className="size-3.5" /> <ChevronDown className="size-3" />
          </Button>
        )}
      </Toolbar>
      {builderOpen && info.data && (
        <QueryBuilder
          columns={info.data.columns}
          dialect={dialect}
          applied={query}
          onApply={applyQuery}
          onClose={() => setBuilderOpen(false)}
        />
      )}
      <ProgressBar active={loading || exporting} />
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          {error ? (
            <div className="p-4">
              <ErrorText error={error} />
            </div>
          ) : set ? (
            <ResultGrid
              columns={columns}
              rows={rows}
              editing={editing}
              sort={gridSort}
              // A header click sorts by that column alone; the builder handles multi-column sorts
              onSortChange={(s) =>
                applyQuery({
                  ...query,
                  sorts: s ? [{ column: columns[s.col].name, dir: s.dir }] : []
                })
              }
              filter={filter}
              dialect={dialect}
              tableName={qualified(dialect, tableRef)}
              onFilterByValue={filterByValue}
              cellMenuItems={referenceItems}
              rowOffset={from}
              onSelectionSummary={selectionSummaryStore.set}
            />
          ) : (
            <EmptyState title="Loading…" icon={<Spinner className="size-5" />} />
          )}
        </div>
        {canEdit && panelOpen && info.data && (
          <ChangesPanel
            changes={changes}
            columns={columns}
            primaryKey={pk}
            info={info.data}
            dialect={dialect}
            tableRef={tableRef}
            visibleKeys={new Set(baseRecords.map((r) => r.key))}
            readOnlyColumns={
              new Set(info.data.columns.filter((c) => c.isGenerated).map((c) => c.name))
            }
            busy={loading}
            onChange={setChanges}
            onCommit={(ids) => void commit(ids)}
            onCancelAll={() => setChanges([])}
            onClose={() => setPanelOpen(false)}
          />
        )}
      </div>
      {output && (
        <div className="flex h-6 shrink-0 items-center gap-3 border-t border-line bg-panel px-3 text-[11px] text-muted">
          <span>{plural(baseRows.length, 'row')}</span>
          <span className="text-faint">{formatDuration(output.elapsedMs)}</span>
          {canEdit && (
            <span className="text-faint">
              Double-click or F2 to edit · Delete removes rows · changes wait in Pending until
              committed
            </span>
          )}
        </div>
      )}
    </>
  )
}

function StructureView({
  tab,
  engine,
  dialect
}: {
  tab: TabOf<'table'>
  engine: Engine
  dialect: Dialect
}): React.JSX.Element {
  const q = useQuery(queries.table(tab.connectionId, tab.database, tab.schema, tab.name))
  if (q.isPending) return <EmptyState title="Loading…" icon={<Spinner className="size-5" />} />
  if (q.isError)
    return (
      <div className="p-4">
        <ErrorText error={q.error} />
      </div>
    )
  const info: TableInfo = q.data
  const triggers = canHaveTriggers(dialect, tab.objectKind)
  const isView = tab.objectKind === 'view'
  return (
    <>
      {(tab.objectKind === 'table' || triggers) && (
        <Toolbar>
          {tab.objectKind === 'table' && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                openTableDesigner(tab.connectionId, tab.database, tab.schema, tab.name)
              }
            >
              <Pencil className="size-3.5" /> Design table…
            </Button>
          )}
          {triggers && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                openTriggerDesigner(tab.connectionId, tab.database, tab.schema, tab.name, isView)
              }
            >
              <Zap className="size-3.5" /> New trigger…
            </Button>
          )}
        </Toolbar>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <Section title="Columns" count={info.columns.length}>
          <table className="w-full text-left text-[12.5px]">
            <thead className="text-[11px] text-muted">
              <tr className="border-b border-line">
                <th className="w-8 py-1.5 font-medium" />
                <th className="py-1.5 font-medium">Name</th>
                <th className="py-1.5 font-medium">Type</th>
                <th className="py-1.5 font-medium">Nullable</th>
                <th className="py-1.5 font-medium">Default</th>
                <th className="py-1.5 font-medium">Comment</th>
              </tr>
            </thead>
            <tbody className="select-text">
              {info.columns.map((c, i) => (
                <tr key={c.name} className="border-b border-line/60 hover:bg-hover/40">
                  <td className="py-1.5 text-faint tabular-nums">
                    {c.isPrimaryKey ? <KeyRound className="size-3.5 text-warn" /> : i + 1}
                  </td>
                  <td className="py-1.5 font-mono text-bright">
                    {c.name}
                    {c.isGenerated && (
                      <Badge className="ml-2" tone="info">
                        generated
                      </Badge>
                    )}
                  </td>
                  <td className="py-1.5 font-mono text-syn-type">{c.dataType}</td>
                  <td className="py-1.5">
                    {c.nullable ? (
                      <span className="text-muted">null</span>
                    ) : (
                      <span className="text-fg">not null</span>
                    )}
                  </td>
                  <td
                    className="max-w-64 truncate py-1.5 font-mono text-[11.5px] text-muted"
                    title={c.default ?? undefined}
                  >
                    {c.default}
                  </td>
                  <td
                    className="max-w-64 truncate py-1.5 text-muted"
                    title={c.comment ?? undefined}
                  >
                    {c.comment}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
        <Section title="Indexes" count={info.indexes.length}>
          {info.indexes.length ? (
            <table className="w-full text-left text-[12.5px]">
              <tbody className="select-text">
                {info.indexes.map((ix) => (
                  <tr key={ix.name} className="border-b border-line/60">
                    <td className="py-1.5 font-mono text-bright">{ix.name}</td>
                    <td className="py-1.5 font-mono text-muted">({ix.columns.join(', ')})</td>
                    <td className="py-1.5">
                      {ix.primary ? (
                        <Badge tone="warning">primary</Badge>
                      ) : ix.unique ? (
                        <Badge tone="info">unique</Badge>
                      ) : null}
                    </td>
                    <td className="py-1.5 text-faint">{ix.method}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-xs text-faint">No indexes</p>
          )}
        </Section>
        <Section title="Foreign keys" count={info.foreignKeys.length}>
          {info.foreignKeys.length ? (
            <div className="space-y-1.5">
              {info.foreignKeys.map((fk) => (
                <div
                  key={fk.name}
                  className="flex items-center gap-2 font-mono text-[12px] select-text"
                >
                  <Link2 className="size-3.5 shrink-0 text-syn-fn" />
                  <span className="text-bright">{fk.name}</span>
                  <span className="text-muted">
                    ({fk.columns.join(', ')}) →{' '}
                    <button
                      className="text-info hover:underline"
                      onClick={() => {
                        const target = fkTarget(engine, tab, fk)
                        openTable(
                          tab.connectionId,
                          target.database,
                          target.schema,
                          fk.refTable,
                          'table',
                          'structure'
                        )
                      }}
                    >
                      {fk.refSchema ? `${fk.refSchema}.` : ''}
                      {fk.refTable}
                    </button>
                    ({fk.refColumns.join(', ')})
                  </span>
                  {fk.onDelete && fk.onDelete !== 'NO ACTION' && (
                    <Badge>on delete {fk.onDelete.toLowerCase()}</Badge>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-faint">No foreign keys</p>
          )}
        </Section>
        <Section title="Triggers" count={info.triggers.length}>
          {info.triggers.length ? (
            <div className="space-y-1.5">
              {info.triggers.map((t) => (
                <TriggerRow key={t.name} tab={tab} trigger={t} editable={triggers} />
              ))}
            </div>
          ) : (
            <p className="text-xs text-faint">No triggers</p>
          )}
        </Section>
      </div>
    </>
  )
}

function TriggerRow({
  tab,
  trigger,
  editable
}: {
  tab: TabOf<'table'>
  trigger: TriggerInfo
  editable: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <div>
      <div className="flex items-center gap-2 font-mono text-[12px]">
        <button
          className="flex min-w-0 items-center gap-2 text-left disabled:cursor-default"
          disabled={!trigger.definition}
          onClick={() => setOpen((o) => !o)}
        >
          <Chevron
            className={cn('size-3.5 shrink-0 text-faint', !trigger.definition && 'invisible')}
          />
          <Zap className="size-3.5 shrink-0 text-syn-fn" />
          <span className="truncate text-bright select-text">{trigger.name}</span>
        </button>
        <span className="text-muted">
          {trigger.timing.toLowerCase()} {trigger.events.join(' or ').toLowerCase()}
        </span>
        <span className="text-faint">{trigger.rowLevel ? 'for each row' : 'per statement'}</span>
        {!trigger.enabled && <Badge tone="warning">disabled</Badge>}
        <span className="ml-auto flex gap-3 text-[11px]">
          {editable && (
            <button
              className="text-info hover:underline"
              onClick={() =>
                openTriggerDesigner(
                  tab.connectionId,
                  tab.database,
                  tab.schema,
                  tab.name,
                  tab.objectKind === 'view',
                  trigger.name
                )
              }
            >
              Edit…
            </button>
          )}
          {trigger.definition && (
            <button
              className="text-info hover:underline"
              onClick={() => newQueryTab(tab.connectionId, tab.database, trigger.definition ?? '')}
            >
              Open in editor
            </button>
          )}
        </span>
      </div>
      {open && trigger.definition && (
        <pre className="mt-1.5 mb-2 ml-11 overflow-x-auto rounded border border-line bg-canvas p-2 font-mono text-[11.5px] text-fg select-text">
          {trigger.definition}
        </pre>
      )}
    </div>
  )
}

function Section({
  title,
  count,
  children
}: {
  title: string
  count: number
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="mb-6">
      <h3 className="mb-2 flex items-center gap-2 text-[11px] font-semibold tracking-wider text-muted uppercase">
        {title} <span className="font-normal text-faint">{count}</span>
      </h3>
      {children}
    </section>
  )
}

function DefinitionView({
  tab,
  dialect,
  tableRef
}: {
  tab: TabOf<'table'>
  dialect: Dialect
  tableRef: TableRef
}): React.JSX.Element {
  const connection = connectionsStore.use().find((c) => c.id === tab.connectionId)
  const isTable = tab.objectKind === 'table' || tab.objectKind === 'foreign_table'
  const useServerDdl = !isTable || connection?.engine === 'mysql'
  const definition = useQuery({
    ...queries.definition(
      tab.connectionId,
      tab.database,
      tab.schema,
      tab.name,
      tab.objectKind,
      tab.detail
    ),
    enabled: useServerDdl
  })
  const info = useQuery({
    ...queries.table(tab.connectionId, tab.database, tab.schema, tab.name),
    enabled: !useServerDdl
  })
  const text = useServerDdl
    ? (definition.data ?? (definition.isPending ? '' : '-- No definition available'))
    : info.data
      ? scriptCreateTable(dialect, tableRef, info.data)
      : ''
  const error = useServerDdl ? definition.error : info.error
  const routineKind =
    tab.objectKind === 'procedure' || tab.objectKind === 'function' ? tab.objectKind : null
  const routine: DbObject = {
    schema: tab.schema,
    name: tab.name,
    kind: tab.objectKind,
    detail: tab.detail ?? null,
    comment: null,
    rowEstimate: null
  }
  return (
    <>
      <Toolbar>
        {routineKind && (
          <>
            <Button
              size="sm"
              variant="primary"
              onClick={() => openExecuteRoutine(tab.connectionId, tab.database, routine)}
            >
              <Play className="size-3.5 fill-current" /> Execute…
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!definition.data}
              onClick={() =>
                definition.data &&
                newQueryTab(
                  tab.connectionId,
                  tab.database,
                  modifyScript(dialect, definition.data, tableRef, routineKind)
                )
              }
            >
              <Pencil className="size-3.5" /> {dialect === 'tsql' ? 'Modify (ALTER)' : 'Modify'}
            </Button>
          </>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => newQueryTab(tab.connectionId, tab.database, text)}
          disabled={!text}
        >
          <FilePlus2 className="size-3.5" /> Open in editor
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void copyText(text, 'Copied definition')}
          disabled={!text}
        >
          <ClipboardCopy className="size-3.5" /> Copy
        </Button>
        {!useServerDdl && (
          <span className="ml-2 text-[11px] text-faint">
            Generated from the catalog; storage options and triggers aren&apos;t included.
          </span>
        )}
      </Toolbar>
      <div className="min-h-0 flex-1">
        {error ? (
          <div className="p-4">
            <ErrorText error={error} />
          </div>
        ) : (
          <CodeEditor
            value={text}
            language={{ kind: 'sql', dialect }}
            readOnly
            className="h-full bg-canvas"
            fontSize={settingsStore.get().editorFontSize}
          />
        )}
      </div>
    </>
  )
}
