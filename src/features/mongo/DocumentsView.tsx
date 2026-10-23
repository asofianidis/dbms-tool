import { useMemo, useState } from 'react'
import { ClipboardCopy, Copy, Pencil, Trash2 } from 'lucide-react'
import type { Cell, ColumnMeta } from '@/lib/api'
import { cn } from '@/lib/cn'
import { copyText } from '@/lib/export'
import { bsonType, isContainer, scalarText, toShell } from '@/lib/ejson'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { ResultGrid } from '@/components/grid/ResultGrid'
import { Button, EmptyState, Segmented } from '@/components/ui'
import { selectionSummaryStore } from '@/components/shell/StatusBar'
import { JsonTree } from './JsonTree'

export type DocumentsMode = 'list' | 'table' | 'json'

type Doc = Record<string, unknown>

const LIST_LIMIT = 500

/** Flattens documents into grid columns: top-level fields, `_id` first. */
export function documentsToGrid(documents: Doc[]): { columns: ColumnMeta[]; rows: Cell[][] } {
  const keys: string[] = []
  const seen = new Set<string>()
  for (const doc of documents.slice(0, 2000)) {
    for (const k of Object.keys(doc)) {
      if (!seen.has(k)) {
        seen.add(k)
        keys.push(k)
      }
    }
  }
  keys.sort((a, b) => (a === '_id' ? -1 : b === '_id' ? 1 : 0))
  const types = new Map<string, Set<string>>()
  const rows = documents.map((doc) =>
    keys.map((k): Cell => {
      if (!(k in doc)) return null
      const v = doc[k]
      const type = bsonType(v)
      ;(types.get(k) ?? types.set(k, new Set()).get(k)!).add(type)
      if (v === null) return null
      if (isContainer(v)) return toShell(v, 0)
      if (type === 'Boolean') return v as boolean
      return scalarText(v)
    })
  )
  const columns = keys.map((k) => {
    const t = [...(types.get(k) ?? [])].filter((x) => x !== 'Null')
    return {
      name: k,
      typeName:
        t.length === 1
          ? /Int|Double|Decimal/.test(t[0])
            ? 'numeric'
            : t[0]
          : t.length
            ? 'mixed'
            : ''
    }
  })
  return { columns, rows }
}

export function DocumentsView({
  documents,
  mode,
  onModeChange,
  onEdit,
  onClone,
  onDelete,
  toolbarExtra,
  className
}: {
  documents: Doc[]
  mode: DocumentsMode
  onModeChange: (mode: DocumentsMode) => void
  onEdit?: (doc: Doc) => void
  onClone?: (doc: Doc) => void
  onDelete?: (doc: Doc) => void
  toolbarExtra?: React.ReactNode
  className?: string
}): React.JSX.Element {
  const grid = useMemo(
    () => (mode === 'table' ? documentsToGrid(documents) : null),
    [documents, mode]
  )
  const json = useMemo(
    () =>
      mode === 'json'
        ? documents
            .slice(0, 2000)
            .map((d) => toShell(d))
            .join(',\n')
        : '',
    [documents, mode]
  )
  const [expandAll, setExpandAll] = useState(false)

  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-line bg-panel px-2">
        <Segmented
          size="sm"
          value={mode}
          onChange={onModeChange}
          options={[
            { value: 'list', label: 'List' },
            { value: 'table', label: 'Table' },
            { value: 'json', label: 'JSON' }
          ]}
        />
        {mode === 'list' && (
          <button
            className="text-[11px] text-muted hover:text-bright"
            onClick={() => setExpandAll((e) => !e)}
          >
            {expandAll ? 'Collapse all' : 'Expand all'}
          </button>
        )}
        <div className="flex-1" />
        {toolbarExtra}
      </div>
      <div className="min-h-0 flex-1">
        {!documents.length ? (
          <EmptyState title="No documents" />
        ) : mode === 'table' && grid ? (
          <ResultGrid
            columns={grid.columns}
            rows={grid.rows}
            onSelectionSummary={selectionSummaryStore.set}
          />
        ) : mode === 'json' ? (
          <CodeEditor
            value={json}
            language={{ kind: 'mongo' }}
            readOnly
            className="h-full bg-canvas"
            fontSize={12.5}
          />
        ) : (
          <div className="h-full overflow-auto bg-canvas p-3">
            <div className="space-y-2">
              {documents.slice(0, LIST_LIMIT).map((doc, i) => (
                <DocumentCard
                  key={`${i}:${scalarText(doc._id)}`}
                  doc={doc}
                  expandAll={expandAll}
                  onEdit={onEdit}
                  onClone={onClone}
                  onDelete={onDelete}
                />
              ))}
            </div>
            {documents.length > LIST_LIMIT && (
              <p className="py-3 text-center text-xs text-muted">
                Showing the first {LIST_LIMIT} of {documents.length.toLocaleString()} documents.
                Switch to Table for the rest.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function DocumentCard({
  doc,
  expandAll,
  onEdit,
  onClone,
  onDelete
}: {
  doc: Doc
  expandAll: boolean
  onEdit?: (doc: Doc) => void
  onClone?: (doc: Doc) => void
  onDelete?: (doc: Doc) => void
}): React.JSX.Element {
  return (
    <div
      className="group relative rounded-lg border border-line bg-panel/70 px-2 py-2 transition-colors hover:border-line-strong"
      onDoubleClick={() => onEdit?.(doc)}
    >
      <JsonTree key={String(expandAll)} value={doc} expandAll={expandAll} />
      <div className="absolute top-1.5 right-1.5 flex gap-0.5 rounded-md border border-line-strong bg-raised p-0.5 opacity-0 shadow-lg group-hover:opacity-100">
        {onEdit && (
          <Button size="icon-sm" variant="ghost" title="Edit document" onClick={() => onEdit(doc)}>
            <Pencil className="size-3.5" />
          </Button>
        )}
        <Button
          size="icon-sm"
          variant="ghost"
          title="Copy document"
          onClick={() => void copyText(toShell(doc), 'Copied document')}
        >
          <ClipboardCopy className="size-3.5" />
        </Button>
        {onClone && (
          <Button
            size="icon-sm"
            variant="ghost"
            title="Clone document"
            onClick={() => onClone(doc)}
          >
            <Copy className="size-3.5" />
          </Button>
        )}
        {onDelete && (
          <Button
            size="icon-sm"
            variant="ghost"
            title="Delete document"
            onClick={() => onDelete(doc)}
            className="hover:text-danger"
          >
            <Trash2 className="size-3.5" />
          </Button>
        )}
      </div>
    </div>
  )
}
