import { useCallback, useEffect, useState } from 'react'
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
  SlidersHorizontal
} from 'lucide-react'
import { api, type MongoOutput } from '@/lib/api'
import { cn } from '@/lib/cn'
import { exportRows } from '@/lib/export'
import { parseShellValue, scalarText, toShell } from '@/lib/ejson'
import { shellCollection } from '@/lib/mongo-shell'
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
import { DocumentEditor, type DocumentEditorRequest } from './DocumentEditor'
import { DocumentsView, documentsToGrid, type DocumentsMode } from './DocumentsView'
import { AggregationView } from './AggregationView'
import { SchemaView } from './SchemaView'
import { IndexesView } from './IndexesView'

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
            { value: 'indexes', label: 'Indexes' }
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
      ) : (
        <IndexesView tab={tab} readOnly={connection.readOnly} />
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

  const parse = (text: string, what: string): unknown => {
    if (!text.trim()) return undefined
    try {
      return parseShellValue(text)
    } catch (e) {
      throw new Error(`${what}: ${errorMessage(e)}`)
    }
  }

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const out = await api.mongo(tab.connectionId, tab.id, {
        op: 'find',
        database: tab.database,
        collection: tab.collection,
        filter: parse(applied.filter, 'Filter') ?? {},
        projection: parse(applied.projection, 'Project'),
        sort: parse(applied.sort, 'Sort'),
        skip: page * pageSize,
        limit: pageSize,
        count: true
      })
      setOutput(out)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setLoading(false)
    }
  }, [tab.connectionId, tab.id, tab.database, tab.collection, applied, page, pageSize])

  useEffect(() => {
    void load()
  }, [load])

  const apply = (): void => {
    setApplied({ filter, projection, sort })
    setPage(0)
  }

  const reset = (): void => {
    setFilter('')
    setProjection('')
    setSort('')
    setApplied({ filter: '', projection: '', sort: '' })
    setPage(0)
  }

  const explain = async (): Promise<void> => {
    try {
      const find: Record<string, unknown> = {
        find: tab.collection,
        filter: parse(applied.filter, 'Filter') ?? {}
      }
      if (applied.sort) find.sort = parse(applied.sort, 'Sort')
      const out = await api.mongo(tab.connectionId, tab.id, {
        op: 'runCommand',
        database: tab.database,
        command: { explain: find, verbosity: 'executionStats' }
      })
      const value = out.value as Record<string, unknown>
      const stats = value.executionStats as Record<string, unknown> | undefined
      const plan = JSON.stringify(
        (value.queryPlanner as Record<string, unknown>)?.winningPlan ?? {}
      )
      const stages = [...plan.matchAll(/"stage":"(\w+)"/g)].map((m) => m[1])
      const indexName = /"indexName":"([^"]+)"/.exec(plan)?.[1]
      toast(
        `${stages.join(' → ') || 'plan'}${indexName ? ` using ${indexName}` : ''}${stats ? ` · examined ${scalarText(stats.totalDocsExamined)} docs, returned ${scalarText(stats.nReturned)} in ${scalarText(stats.executionTimeMillis)} ms` : ''}`,
        stages.includes('COLLSCAN') ? 'error' : 'info'
      )
    } catch (e) {
      toastError(e)
    }
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
      <ProgressBar active={loading} />
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
                  onClick={() =>
                    newQueryTab(
                      tab.connectionId,
                      tab.database,
                      `${shellCollection(tab.collection)}.find(${applied.filter || '{}'}${applied.projection ? `, ${applied.projection}` : ''})${applied.sort ? `\n  .sort(${applied.sort})` : ''}\n  .limit(${pageSize})`
                    )
                  }
                >
                  <Code2 className="size-3.5" /> Shell
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  title="Export this page"
                  onClick={() => {
                    const grid = documentsToGrid(output.documents)
                    void exportRows(
                      mode === 'table' ? 'csv' : 'json',
                      grid.columns,
                      grid.rows,
                      tab.collection
                    )
                  }}
                >
                  <Download className="size-3.5" />
                </Button>
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
