import { useCallback, useEffect, useMemo, useState } from 'react'
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
  Lock,
  Plus,
  RefreshCw,
  Save,
  Undo2
} from 'lucide-react'
import {
  api,
  type Cell,
  type ColumnMeta,
  type DbObject,
  type ExecOutput,
  type TableInfo
} from '@/lib/api'
import { modifyScript } from '@/lib/routines'
import { cn } from '@/lib/cn'
import { ENGINES, type Dialect } from '@/lib/engines'
import { copyText } from '@/lib/export'
import { formatDuration, plural } from '@/lib/format'
import { queries } from '@/lib/queries'
import { settingsStore } from '@/lib/settings'
import {
  countRows,
  editStatements,
  literal,
  qualified,
  quoteIdent,
  scriptCreateTable,
  selectRows,
  wrapInTransaction,
  type RowEdit,
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
import { openTableDesigner } from './TableDesigner'

interface Edits {
  updates: Map<number, Map<number, Cell>>
  deleted: Set<number>
  inserted: Cell[][]
}

const emptyEdits = (): Edits => ({ updates: new Map(), deleted: new Set(), inserted: [] })

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
          dialect={dialect}
          tableRef={ref}
          readOnly={connection.readOnly || tab.objectKind !== 'table'}
        />
      ) : tab.view === 'structure' && browsable ? (
        <StructureView tab={tab} />
      ) : (
        <DefinitionView tab={tab} dialect={dialect} tableRef={ref} />
      )}
    </div>
  )
}

function DataView({
  tab,
  dialect,
  tableRef,
  readOnly
}: {
  tab: TabOf<'table'>
  dialect: Dialect
  tableRef: TableRef
  readOnly: boolean
}): React.JSX.Element {
  const { pageSize, confirmDangerous } = settingsStore.use()
  const info = useQuery(queries.table(tab.connectionId, tab.database, tab.schema, tab.name))
  const [where, setWhere] = useState('')
  const [appliedWhere, setAppliedWhere] = useState('')
  const [sort, setSort] = useState<SortState>(null)
  const [page, setPage] = useState(0)
  const [output, setOutput] = useState<ExecOutput | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [total, setTotal] = useState<number | null>(null)
  const [edits, setEdits] = useState<Edits>(emptyEdits)
  const [filter, setFilter] = useState('')

  const set = output?.results[0]
  const columns: ColumnMeta[] = set?.columns ?? []
  const pk = info.data?.primaryKey ?? []
  const canEdit = !readOnly && pk.length > 0 && !!info.data

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    setRunning(tab.id, true)
    try {
      // Default to primary-key order so rows don't move around after an edit
      const orderBy =
        sort && columns[sort.col]
          ? `${quoteIdent(dialect, columns[sort.col].name)} ${sort.dir.toUpperCase()}`
          : pk.length
            ? pk.map((k) => quoteIdent(dialect, k)).join(', ')
            : undefined
      const sql = selectRows(dialect, tableRef, {
        where: appliedWhere,
        orderBy,
        limit: pageSize,
        offset: page * pageSize,
        keyColumns: pk
      })
      const out = await api.execute(tab.connectionId, tab.id, tab.database, sql, {
        maxRows: pageSize
      })
      if (out.error) setError(out.error.message)
      else {
        setOutput(out)
        setEdits(emptyEdits())
      }
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
    sort,
    page,
    pageSize,
    pk.join(',')
  ])

  useEffect(() => {
    if (info.isPending) return
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedWhere, sort, page, pageSize, info.isPending])

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

  const baseRows = set?.rows ?? []
  const rows = useMemo(() => {
    const merged = baseRows.map((r, i) => {
      const changes = edits.updates.get(i)
      if (!changes) return r
      const copy = [...r]
      for (const [c, v] of changes) copy[c] = v
      return copy
    })
    return [...merged, ...edits.inserted]
  }, [baseRows, edits])

  const changeCount = edits.updates.size + edits.deleted.size + edits.inserted.length

  const generatedColumns = useMemo(() => {
    const generated = new Set<number>()
    columns.forEach((c, i) => {
      if (info.data?.columns.find((col) => col.name === c.name)?.isGenerated) generated.add(i)
    })
    return generated
  }, [columns, info.data])

  const buildEdits = (): RowEdit[] => {
    const original = (r: number): Record<string, Cell> =>
      Object.fromEntries(columns.map((c, i) => [c.name, baseRows[r][i]]))
    const list: RowEdit[] = []
    for (const r of edits.deleted)
      if (r < baseRows.length) list.push({ kind: 'delete', original: original(r) })
    for (const [r, changes] of edits.updates) {
      if (edits.deleted.has(r)) continue
      list.push({
        kind: 'update',
        original: original(r),
        values: Object.fromEntries([...changes].map(([c, v]) => [columns[c].name, v]))
      })
    }
    edits.inserted.forEach((row, i) => {
      if (edits.deleted.has(baseRows.length + i)) return
      const values: Record<string, Cell> = {}
      row.forEach((v, c) => {
        // Leave untouched cells out so defaults and identities apply
        if (v !== null && !generatedColumns.has(c)) values[columns[c].name] = v
      })
      list.push({ kind: 'insert', values })
    })
    return list
  }

  const saveChanges = async (): Promise<void> => {
    if (!info.data) return
    const statements = editStatements(dialect, tableRef, info.data, buildEdits())
    if (!statements.length) return setEdits(emptyEdits())
    const script = wrapInTransaction(dialect, statements)
    if (confirmDangerous || edits.deleted.size > 0) {
      const ok = await confirm({
        title: `Apply ${plural(statements.length, 'change')}?`,
        message: 'These statements run in one transaction; if any fails, none are applied.',
        code: script,
        confirmLabel: 'Apply changes',
        danger: edits.deleted.size > 0
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
        toast(`Changes not saved: ${out.error.message}`, 'error')
      } else {
        toast(`Saved ${plural(statements.length, 'change')}`)
        await load()
      }
    } catch (e) {
      toastError(e)
    } finally {
      setLoading(false)
    }
  }

  const editing = canEdit
    ? {
        onEdit: (row: number, col: number, value: Cell) =>
          setEdits((e) => {
            if (row >= baseRows.length) {
              const inserted = e.inserted.map((r, i) =>
                i === row - baseRows.length ? r.map((v, c) => (c === col ? value : v)) : r
              )
              return { ...e, inserted }
            }
            const updates = new Map(e.updates)
            const changes = new Map(updates.get(row) ?? [])
            if (value === baseRows[row][col]) changes.delete(col)
            else changes.set(col, value)
            if (changes.size) updates.set(row, changes)
            else updates.delete(row)
            return { ...e, updates }
          }),
        rowStatus: (row: number) =>
          edits.deleted.has(row)
            ? ('deleted' as const)
            : row >= baseRows.length
              ? ('inserted' as const)
              : undefined,
        isModified: (row: number, col: number) => !!edits.updates.get(row)?.has(col),
        onDeleteRows: (list: number[]) =>
          setEdits((e) => {
            // Deleting a new row just drops it
            const newRows = new Set(
              list.filter((r) => r >= baseRows.length).map((r) => r - baseRows.length)
            )
            const deleted = new Set(e.deleted)
            for (const r of list) if (r < baseRows.length) deleted.add(r)
            return { ...e, deleted, inserted: e.inserted.filter((_, i) => !newRows.has(i)) }
          }),
        onRevertRows: (list: number[]) =>
          setEdits((e) => {
            const updates = new Map(e.updates)
            const deleted = new Set(e.deleted)
            for (const r of list) {
              updates.delete(r)
              deleted.delete(r)
            }
            return { ...e, updates, deleted }
          }),
        readOnlyColumns: generatedColumns
      }
    : undefined

  const filterByValue = (column: string, value: Cell): void => {
    const clause =
      value === null
        ? `${quoteIdent(dialect, column)} IS NULL`
        : `${quoteIdent(dialect, column)} = ${literal(dialect, value, info.data?.columns.find((c) => c.name === column)?.dataType)}`
    const next = appliedWhere ? `(${appliedWhere}) AND ${clause}` : clause
    setWhere(next)
    setAppliedWhere(next)
    setPage(0)
  }

  const from = page * pageSize
  const hasNext = (set?.rowCount ?? 0) >= pageSize

  return (
    <>
      <Toolbar className="gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-0 rounded-md border border-line-strong bg-canvas focus-within:border-accent/50">
          <span className="pl-2.5 font-mono text-[11px] font-medium text-syn-keyword">WHERE</span>
          <input
            value={where}
            onChange={(e) => setWhere(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                setAppliedWhere(where)
                setPage(0)
              }
            }}
            spellCheck={false}
            placeholder={
              info.data?.columns[0]
                ? `${quoteIdent(dialect, info.data.columns[0].name)} = …   (Enter to apply)`
                : 'condition'
            }
            className="h-7 min-w-0 flex-1 bg-transparent px-2 font-mono text-[12px] text-bright placeholder:text-faint focus:outline-none"
          />
          {appliedWhere && (
            <button
              className="px-2 text-[11px] text-muted hover:text-bright"
              onClick={() => {
                setWhere('')
                setAppliedWhere('')
                setPage(0)
              }}
            >
              Clear
            </button>
          )}
        </div>
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
              ? `${(from + (set.rows.length ? 1 : 0)).toLocaleString()}–${(from + set.rows.length).toLocaleString()}`
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
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                setEdits((e) => ({ ...e, inserted: [...e.inserted, columns.map(() => null)] }))
              }
              title="Add row"
            >
              <Plus className="size-3.5" /> Row
            </Button>
            {changeCount > 0 && (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setEdits(emptyEdits())}
                  title="Discard changes"
                >
                  <Undo2 className="size-3.5" /> Discard
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => void saveChanges()}
                  disabled={loading}
                >
                  <Save className="size-3.5" /> Save {changeCount}
                </Button>
              </>
            )}
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
            onClick={(e) =>
              exportMenu(
                e.currentTarget,
                { columns, rows },
                tab.name,
                dialect,
                qualified(dialect, tableRef)
              )
            }
          >
            <Download className="size-3.5" /> <ChevronDown className="size-3" />
          </Button>
        )}
      </Toolbar>
      <ProgressBar active={loading} />
      <div className="min-h-0 flex-1">
        {error ? (
          <div className="p-4">
            <ErrorText error={error} />
          </div>
        ) : set ? (
          <ResultGrid
            columns={columns}
            rows={rows}
            editing={editing}
            sort={sort}
            onSortChange={(s) => {
              setSort(s)
              setPage(0)
            }}
            filter={filter}
            dialect={dialect}
            tableName={qualified(dialect, tableRef)}
            onFilterByValue={filterByValue}
            rowOffset={from}
            onSelectionSummary={selectionSummaryStore.set}
          />
        ) : (
          <EmptyState title="Loading…" icon={<Spinner className="size-5" />} />
        )}
      </div>
      {output && (
        <div className="flex h-6 shrink-0 items-center gap-3 border-t border-line bg-panel px-3 text-[11px] text-muted">
          <span>{plural(set?.rows.length ?? 0, 'row')}</span>
          <span className="text-faint">{formatDuration(output.elapsedMs)}</span>
          {canEdit && (
            <span className="text-faint">
              Double-click or F2 to edit · Delete removes rows · changes save in one transaction
            </span>
          )}
        </div>
      )}
    </>
  )
}

function StructureView({ tab }: { tab: TabOf<'table'> }): React.JSX.Element {
  const q = useQuery(queries.table(tab.connectionId, tab.database, tab.schema, tab.name))
  if (q.isPending) return <EmptyState title="Loading…" icon={<Spinner className="size-5" />} />
  if (q.isError)
    return (
      <div className="p-4">
        <ErrorText error={q.error} />
      </div>
    )
  const info: TableInfo = q.data
  return (
    <>
      {tab.objectKind === 'table' && (
        <Toolbar>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => openTableDesigner(tab.connectionId, tab.database, tab.schema, tab.name)}
          >
            <Pencil className="size-3.5" /> Design table…
          </Button>
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
                      onClick={() =>
                        openTable(
                          tab.connectionId,
                          tab.database,
                          fk.refSchema,
                          fk.refTable,
                          'table',
                          'structure'
                        )
                      }
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
      </div>
    </>
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
