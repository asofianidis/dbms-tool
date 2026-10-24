import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronLeft,
  ChevronRight,
  Code2,
  Download,
  Gauge,
  Lock,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Square
} from 'lucide-react'
import { api, type Cell, type MongoExportFormat, type MongoOutput } from '@/lib/api'
import { cn } from '@/lib/cn'
import { exportRows } from '@/lib/export'
import { parseShellValue, toShell } from '@/lib/ejson'
import { emptyQuery, newCondition, type QueryState } from '@/lib/filters'
import { andFilters, buildMongoFilter, buildMongoSort, sampleFields } from '@/lib/mongo-filters'
import { shellCollection } from '@/lib/mongo-shell'
import type { Plan } from '@/lib/plan'
import { parseMongoExplain } from '@/lib/plan-mongo'
import { formatDuration, plural } from '@/lib/format'
import { settingsStore } from '@/lib/settings'
import { errorMessage, toast, toastError } from '@/lib/toast'
import {
  confirm,
  connect,
  connectionsStore,
  newQueryTab,
  statusStore,
  updateTab,
  type CollectionView,
  type TabOf
} from '@/lib/workspace'
import {
  Badge,
  Button,
  EmptyState,
  ErrorText,
  ProgressBar,
  Segmented,
  Spinner
} from '@/components/ui'
import { showMenuAt } from '@/components/ContextMenu'
import { DocumentEditor, type DocumentEditorRequest } from './DocumentEditor'
import { DocumentsView, documentsToGrid, type DocumentsMode } from './DocumentsView'
import { AggregationView } from './AggregationView'
import { SchemaView } from './SchemaView'
import { IndexesView } from './IndexesView'
import { ValidationView } from './ValidationView'
import { ExplainDialog, exportFormatItems, exportResult } from './exportResult'
import { QueryBuilder, QuerySummary } from '../table/QueryBuilder'

export function CollectionTab({ tab }: { tab: TabOf<'collection'> }): React.JSX.Element {
  const connection = connectionsStore.use().find((c) => c.id === tab.connectionId)
  const connected = statusStore.use()[tab.connectionId]?.state === 'connected'

  useEffect(() => {
    if (!connected && connection) void connect(connection.id)
  }, [connected, connection])

  if (!connection) return <EmptyState title="This connection no longer exists" />

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-3 border-b border-line bg-panel px-3">
        <span className="min-w-0 truncate font-mono text-[12.5px] text-bright">
          <span className="text-muted">{tab.database}.</span>
          {tab.collection}
        </span>
        {connection.readOnly && (
          <Badge tone="warning">
            <Lock className="size-3" /> read-only
          </Badge>
        )}
        <div className="flex-1" />
        <Segmented<CollectionView>
          value={tab.view}
          onChange={(view) => updateTab(tab.id, { view })}
          options={[
            { value: 'documents', label: 'Documents' },
            { value: 'aggregation', label: 'Aggregations' },
            { value: 'schema', label: 'Schema' },
            { value: 'indexes', label: 'Indexes' },
            { value: 'validation', label: 'Validation' }
          ]}
        />
      </div>
      {!connected ? (
        <EmptyState title="Connecting…" icon={<Spinner className="size-5" />} />
      ) : tab.view === 'documents' ? (
        <DocumentsBrowser tab={tab} readOnly={connection.readOnly} />
      ) : tab.view === 'aggregation' ? (
        <AggregationView tab={tab} />
      ) : tab.view === 'schema' ? (
        <SchemaView tab={tab} />
      ) : tab.view === 'indexes' ? (
        <IndexesView tab={tab} readOnly={connection.readOnly} />
      ) : (
        <ValidationView tab={tab} readOnly={connection.readOnly} />
      )}
    </div>
  )
}

function QueryField({
  label,
  value,
  onChange,
  onSubmit,
  placeholder,
  className
}: {
  label: string
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  placeholder: string
  className?: string
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex min-w-0 items-center rounded-md border border-line-strong bg-canvas focus-within:border-accent/50',
        className
      )}
    >
      <span className="shrink-0 pl-2.5 text-[11px] font-medium text-muted">{label}</span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
        spellCheck={false}
        placeholder={placeholder}
        className="h-7 min-w-0 flex-1 bg-transparent px-2 font-mono text-[12px] text-bright placeholder:text-faint focus:outline-none"
      />
    </div>
  )
}

type Doc = Record<string, unknown>

function DocumentsBrowser({
  tab,
  readOnly
}: {
  tab: TabOf<'collection'>
  readOnly: boolean
}): React.JSX.Element {
  const { pageSize } = settingsStore.use()
  const [filter, setFilter] = useState('')
  const [projection, setProjection] = useState('')
  const [sort, setSort] = useState('')
  const [showOptions, setShowOptions] = useState(false)
  const [applied, setApplied] = useState({ filter: '', projection: '', sort: '' })
  const [page, setPage] = useState(0)
  const [output, setOutput] = useState<MongoOutput | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [mode, setMode] = useState<DocumentsMode>('list')
  const [editor, setEditor] = useState<DocumentEditorRequest | null>(null)
  const [query, setQuery] = useState<QueryState>(emptyQuery)
  const [builderOpen, setBuilderOpen] = useState(false)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [exporting, setExporting] = useState(false)
  // Field paths and types sampled from every page loaded so far, for the builder
  const [fields, setFields] = useState<Record<string, string>>({})
  const fieldsRef = useRef(fields)
  fieldsRef.current = fields

  const parse = (text: string, what: string): unknown => {
    if (!text.trim()) return undefined
    try {
      return parseShellValue(text)
    } catch (e) {
      throw new Error(`${what}: ${errorMessage(e)}`)
    }
  }

  /** The typed filter and the builder's conditions both apply; builder sorts come first. */
  const findQuery = useCallback((): { filter: Doc; sort: Doc | undefined } => {
    const filter = andFilters(
      parse(applied.filter, 'Filter') as Doc | undefined,
      buildMongoFilter(query, fieldsRef.current)
    )
    const built = buildMongoSort(query.sorts)
    const typed = parse(applied.sort, 'Sort') as Doc | undefined
    const sort =
      built && typed
        ? { ...built, ...Object.fromEntries(Object.entries(typed).filter(([k]) => !(k in built))) }
        : (built ?? typed)
    return { filter, sort }
  }, [applied, query])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const { filter, sort } = findQuery()
      const out = await api.mongo(tab.connectionId, tab.id, {
        op: 'find',
        database: tab.database,
        collection: tab.collection,
        filter,
        projection: parse(applied.projection, 'Project'),
        sort,
        skip: page * pageSize,
        limit: pageSize,
        count: true
      })
      setOutput(out)
      // Keep known types stable; only add newly seen fields
      setFields((known) => ({ ...sampleFields(out.documents), ...known }))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setLoading(false)
    }
  }, [tab.connectionId, tab.id, tab.database, tab.collection, applied, findQuery, page, pageSize])

  useEffect(() => {
    void load()
  }, [load])

  const apply = (): void => {
    setApplied({ filter, projection, sort })
    setPage(0)
  }

  /** Applies a new filter / sort from the builder, chips or grid header. */
  const applyQuery = (next: QueryState): void => {
    setQuery(next)
    setPage(0)
  }

  const reset = (): void => {
    setFilter('')
    setProjection('')
    setSort('')
    setApplied({ filter: '', projection: '', sort: '' })
    setQuery(emptyQuery())
    setPage(0)
  }

  const filterByValue = (column: string, value: Cell): void => {
    const condition =
      value === null
        ? newCondition({ column, op: 'null' })
        : typeof value === 'boolean'
          ? newCondition({ column, op: value ? 'true' : 'false' })
          : newCondition({ column, op: 'eq', value: String(value) })
    // Narrow the current filter. With "any", fold the existing conditions into one OR group first
    const orGroup = query.match === 'any' && query.conditions.filter((c) => c.enabled).length > 1
    try {
      const folded = orGroup ? buildMongoFilter(query, fields) : null
      applyQuery({
        ...query,
        match: 'all',
        conditions: folded
          ? [newCondition({ kind: 'sql', sql: toShell(folded, 0) }), condition]
          : [...query.conditions, condition]
      })
    } catch (e) {
      toastError(e)
    }
  }

  /** Explains the page query as it runs: filter, sort, projection, skip and limit. */
  const explain = async (): Promise<void> => {
    try {
      const { filter, sort } = findQuery()
      const find: Record<string, unknown> = { find: tab.collection, filter }
      if (sort) find.sort = sort
      const projection = parse(applied.projection, 'Project')
      if (projection) find.projection = projection
      if (page) find.skip = page * pageSize
      find.limit = pageSize
      const out = await api.mongo(tab.connectionId, tab.id, {
        op: 'runCommand',
        database: tab.database,
        command: { explain: find, verbosity: 'executionStats' }
      })
      const parsed = parseMongoExplain(out.value, { collection: tab.collection, filter, sort })
      if (!parsed) throw new Error("The server's explain output has no plan to show")
      setPlan(parsed)
    } catch (e) {
      toastError(e)
    }
  }

  const exportAll = (format: MongoExportFormat): void => {
    let query: { filter: Doc; sort: Doc | undefined; projection: unknown }
    try {
      query = { ...findQuery(), projection: parse(applied.projection, 'Project') }
    } catch (e) {
      toastError(e)
      return
    }
    void exportResult(
      tab.connectionId,
      `${tab.id}:export`,
      { database: tab.database, collection: tab.collection, ...query },
      format,
      tab.collection,
      () => setExporting(true)
    ).finally(() => setExporting(false))
  }

  const remove = async (doc: Record<string, unknown>): Promise<void> => {
    const ok = await confirm({
      title: 'Delete this document?',
      message: <span className="font-mono">_id: {toShell(doc._id, 0)}</span>,
      confirmLabel: 'Delete',
      danger: true
    })
    if (!ok) return
    try {
      await api.mongo(tab.connectionId, '__meta', {
        op: 'deleteOne',
        database: tab.database,
        collection: tab.collection,
        filter: { _id: doc._id }
      })
      toast('Document deleted')
      void load()
    } catch (e) {
      toastError(e)
    }
  }

  const total = output?.total ?? null
  const shown = output?.documents.length ?? 0
  const from = page * pageSize
  const editorBase = {
    connectionId: tab.connectionId,
    database: tab.database,
    collection: tab.collection
  }

  return (
    <>
      <div className="shrink-0 space-y-1.5 border-b border-line bg-panel px-2 py-1.5">
        <div className="flex items-center gap-1.5">
          <QueryField
            label="Filter"
            value={filter}
            onChange={setFilter}
            onSubmit={apply}
            placeholder="{ status: 'active', age: { $gte: 21 } }"
            className="flex-1"
          />
          <Button
            size="icon"
            variant="ghost"
            title="Options: project, sort"
            onClick={() => setShowOptions((s) => !s)}
            className={cn(showOptions && 'text-accent')}
          >
            <SlidersHorizontal className="size-3.5" />
          </Button>
          <Button size="sm" variant="primary" onClick={apply}>
            <Search className="size-3.5" /> Find
          </Button>
          <Button size="icon" variant="ghost" title="Reset" onClick={reset}>
            <RotateCcw className="size-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            title="Explain (execution stats)"
            onClick={() => void explain()}
          >
            <Gauge className="size-3.5" />
          </Button>
        </div>
        {showOptions && (
          <div className="flex items-center gap-1.5">
            <QueryField
              label="Project"
              value={projection}
              onChange={setProjection}
              onSubmit={apply}
              placeholder="{ name: 1, email: 1 }"
              className="flex-1"
            />
            <QueryField
              label="Sort"
              value={sort}
              onChange={setSort}
              onSubmit={apply}
              placeholder="{ createdAt: -1 }"
              className="flex-1"
            />
          </div>
        )}
      </div>
      <ProgressBar active={loading || exporting} />
      <div className="min-h-0 flex-1">
        {error ? (
          <div className="p-4">
            <ErrorText error={error} />
          </div>
        ) : output ? (
          <DocumentsView
            documents={output.documents}
            mode={mode}
            onModeChange={setMode}
            onEdit={
              readOnly
                ? undefined
                : (doc) => setEditor({ ...editorBase, mode: 'edit', document: doc })
            }
            onClone={
              readOnly
                ? undefined
                : (doc) => setEditor({ ...editorBase, mode: 'insert', document: doc })
            }
            onDelete={readOnly ? undefined : (doc) => void remove(doc)}
            toolbarStart={
              <QuerySummary
                query={query}
                open={builderOpen}
                onToggle={() => setBuilderOpen((o) => !o)}
                onChange={applyQuery}
                emptyLabel={applied.filter ? '' : 'All documents'}
              />
            }
            panel={
              builderOpen && (
                <QueryBuilder
                  columns={Object.entries(fields).map(([name, dataType]) => ({ name, dataType }))}
                  dialect="mongo"
                  applied={query}
                  onApply={applyQuery}
                  onClose={() => setBuilderOpen(false)}
                />
              )
            }
            // A header click sorts by that field alone; the builder handles multi-field sorts
            sort={query.sorts[0] ?? null}
            onSortChange={(s) => applyQuery({ ...query, sorts: s ? [s] : [] })}
            onFilterByValue={filterByValue}
            toolbarExtra={
              <div className="flex items-center gap-1 text-[11.5px] text-muted">
                {!readOnly && (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => setEditor({ ...editorBase, mode: 'insert' })}
                  >
                    <Plus className="size-3.5" /> Insert
                  </Button>
                )}
                <Button
                  size="xs"
                  variant="ghost"
                  title="Open this query in a shell tab"
                  onClick={() => {
                    try {
                      const { filter, sort } = findQuery()
                      newQueryTab(
                        tab.connectionId,
                        tab.database,
                        `${shellCollection(tab.collection)}.find(${toShell(filter, 0)}${applied.projection ? `, ${applied.projection}` : ''})${sort ? `\n  .sort(${toShell(sort, 0)})` : ''}\n  .limit(${pageSize})`
                      )
                    } catch (e) {
                      toastError(e)
                    }
                  }}
                >
                  <Code2 className="size-3.5" /> Shell
                </Button>
                {exporting ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    title="Stop the export"
                    onClick={() => void api.cancel(tab.connectionId, `${tab.id}:export`)}
                  >
                    <Spinner className="size-3" /> Exporting…
                    <Square className="size-3 fill-current" />
                  </Button>
                ) : (
                  <Button
                    size="xs"
                    variant="ghost"
                    title="Export this page or every matching document"
                    onClick={(e) => {
                      const page = documentsToGrid(output.documents)
                      showMenuAt(e.currentTarget, [
                        { heading: 'This page' },
                        {
                          label: 'JSON',
                          onSelect: () =>
                            void exportRows('json', page.columns, page.rows, tab.collection)
                        },
                        {
                          label: 'CSV',
                          onSelect: () =>
                            void exportRows('csv', page.columns, page.rows, tab.collection)
                        },
                        {
                          heading:
                            total != null
                              ? `All ${plural(total, 'matching document')}`
                              : 'All matching documents'
                        },
                        ...exportFormatItems(exportAll)
                      ])
                    }}
                  >
                    <Download className="size-3.5" />
                  </Button>
                )}
                <span className="ml-1 tabular-nums">
                  {shown
                    ? `${(from + 1).toLocaleString()}–${(from + shown).toLocaleString()}`
                    : '0'}
                  {total != null && ` of ${total.toLocaleString()}`}
                </span>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  disabled={page === 0}
                  onClick={() => setPage((p) => p - 1)}
                >
                  <ChevronLeft className="size-3.5" />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  disabled={total != null ? from + shown >= total : shown < pageSize}
                  onClick={() => setPage((p) => p + 1)}
                >
                  <ChevronRight className="size-3.5" />
                </Button>
                <Button size="icon-sm" variant="ghost" title="Refresh" onClick={() => void load()}>
                  <RefreshCw className="size-3.5" />
                </Button>
              </div>
            }
          />
        ) : (
          <EmptyState title="Loading…" icon={<Spinner className="size-5" />} />
        )}
      </div>
      {output && (
        <div className="flex h-6 shrink-0 items-center gap-3 border-t border-line bg-panel px-3 text-[11px] text-muted">
          <span>{plural(shown, 'document')}</span>
          <span className="text-faint">{formatDuration(output.elapsedMs)}</span>
          {!readOnly && <span className="text-faint">Double-click a document to edit it</span>}
        </div>
      )}
      {plan && (
        <ExplainDialog
          plan={plan}
          title={`${tab.database}.${tab.collection} · current filter and sort, page ${page + 1}`}
          onClose={() => setPlan(null)}
        />
      )}
      {editor && (
        <DocumentEditor
          request={editor}
          onClose={() => setEditor(null)}
          onSaved={() => void load()}
        />
      )}
    </>
  )
}
