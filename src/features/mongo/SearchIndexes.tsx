import { useCallback, useEffect, useState } from 'react'
import { Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { parseShellValue, scalarText, toShell } from '@/lib/ejson'
import { errorMessage, toast, toastError } from '@/lib/toast'
import { confirm, type TabOf } from '@/lib/workspace'
import {
  Badge,
  Button,
  Field,
  Input,
  Modal,
  Segmented,
  Select,
  Textarea,
  Toggle
} from '@/components/ui'

type SearchKind = 'search' | 'vectorSearch'

type SearchIndexDoc = Record<string, unknown> & {
  name: string
  type?: SearchKind
  status?: string
  queryable?: boolean
  latestDefinition?: Record<string, unknown>
}

// Atlas builds search indexes asynchronously; poll while one is still changing
const SETTLING = new Set(['PENDING', 'BUILDING', 'DELETING'])

/** Atlas Search and Vector Search indexes, managed through the search index commands. */
export function SearchIndexes({
  tab,
  readOnly,
  reloadKey
}: {
  tab: TabOf<'collection'>
  readOnly: boolean
  reloadKey: number
}): React.JSX.Element {
  const [indexes, setIndexes] = useState<SearchIndexDoc[] | null>(null)
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const [editing, setEditing] = useState<SearchIndexDoc | 'new' | null>(null)

  const load = useCallback(async () => {
    try {
      const out = await api.mongo(tab.connectionId, tab.id, {
        op: 'aggregate',
        database: tab.database,
        collection: tab.collection,
        pipeline: [{ $listSearchIndexes: {} }]
      })
      setIndexes(out.documents as SearchIndexDoc[])
      setUnavailable(null)
    } catch (e) {
      // Servers without a search node reject the stage; that's not an error worth shouting about
      setIndexes(null)
      setUnavailable(errorMessage(e))
    }
  }, [tab.connectionId, tab.id, tab.database, tab.collection])

  useEffect(() => {
    void load()
  }, [load, reloadKey])

  const settling = indexes?.some((ix) => SETTLING.has(String(ix.status)))
  useEffect(() => {
    if (!settling) return
    const timer = setTimeout(() => void load(), 5000)
    return () => clearTimeout(timer)
  }, [settling, indexes, load])

  const drop = async (name: string): Promise<void> => {
    const ok = await confirm({
      title: `Drop search index ${name}?`,
      message: '$search and $vectorSearch queries that use it will fail.',
      confirmLabel: 'Drop index',
      danger: true
    })
    if (!ok) return
    try {
      await api.mongo(tab.connectionId, '__meta', {
        op: 'runCommand',
        database: tab.database,
        command: { dropSearchIndex: tab.collection, name }
      })
      toast(`Dropping ${name}`)
      void load()
    } catch (e) {
      toastError(e)
    }
  }

  return (
    <div className="border-t border-line">
      <div className="flex h-9 items-center gap-2 px-3">
        <Search className="size-3.5 text-faint" />
        <span className="text-xs font-medium text-muted">Search indexes</span>
        <span className="text-[11px] text-faint">Atlas Search and Vector Search</span>
        {!readOnly && !unavailable && (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setEditing('new')}>
            <Plus className="size-3.5" /> Create search index
          </Button>
        )}
      </div>
      {unavailable ? (
        <p className="px-3 pb-3 text-xs text-faint" title={unavailable}>
          Not available on this deployment. Search indexes need MongoDB Atlas or a server with a
          search node (mongot).
        </p>
      ) : !indexes ? null : !indexes.length ? (
        <p className="px-3 pb-3 text-xs text-faint">No search indexes</p>
      ) : (
        <table className="w-full text-left text-[12.5px]">
          <thead className="text-[11px] text-muted">
            <tr className="border-b border-line">
              <th className="px-3 py-1.5 font-medium">Name</th>
              <th className="px-3 py-1.5 font-medium">Fields</th>
              <th className="px-3 py-1.5 font-medium">Type</th>
              <th className="px-3 py-1.5 font-medium">Status</th>
              <th className="w-16" />
            </tr>
          </thead>
          <tbody className="select-text">
            {indexes.map((ix) => (
              <tr key={ix.name} className="border-b border-line/60 hover:bg-hover/40">
                <td className="px-3 py-2 font-mono text-bright">{ix.name}</td>
                <td
                  className="max-w-md truncate px-3 py-2 font-mono text-[12px] text-fg"
                  title={ix.latestDefinition ? toShell(ix.latestDefinition, 2) : undefined}
                >
                  {fieldSummary(ix)}
                </td>
                <td className="px-3 py-2">
                  <Badge tone="accent">{ix.type === 'vectorSearch' ? 'vector' : 'search'}</Badge>
                </td>
                <td className="px-3 py-2">
                  <span className="flex items-center gap-1">
                    <Badge tone={statusTone(ix.status)}>
                      {String(ix.status ?? 'unknown').toLowerCase()}
                    </Badge>
                    {ix.queryable === false && ix.status !== 'FAILED' && (
                      <Badge title="Queries can't use this index yet">not queryable</Badge>
                    )}
                  </span>
                </td>
                <td className="px-2">
                  {!readOnly && (
                    <span className="flex">
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        title="Edit definition"
                        onClick={() => setEditing(ix)}
                      >
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        title="Drop search index"
                        onClick={() => void drop(ix.name)}
                        className="hover:text-danger"
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing && (
        <SearchIndexDialog
          tab={tab}
          existing={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => void load()}
        />
      )}
    </div>
  )
}

function statusTone(status: unknown): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'READY') return 'success'
  if (status === 'FAILED' || status === 'DOES_NOT_EXIST') return 'danger'
  if (SETTLING.has(String(status)) || status === 'STALE') return 'warning'
  return 'neutral'
}

function fieldSummary(ix: SearchIndexDoc): string {
  const def = ix.latestDefinition ?? {}
  if (ix.type === 'vectorSearch') {
    const fields = (def.fields as Record<string, unknown>[] | undefined) ?? []
    return fields
      .map((f) =>
        f.type === 'vector'
          ? `${String(f.path)} (${scalarText(f.numDimensions)}d ${String(f.similarity)})`
          : `${String(f.path)} (${String(f.type)})`
      )
      .join(', ')
  }
  const mappings = (def.mappings as Record<string, unknown> | undefined) ?? {}
  const fields = Object.keys((mappings.fields as Record<string, unknown> | undefined) ?? {})
  if (mappings.dynamic) return fields.length ? `dynamic + ${fields.join(', ')}` : 'dynamic'
  return fields.join(', ') || '—'
}

const ANALYZERS = [
  'lucene.standard',
  'lucene.english',
  'lucene.simple',
  'lucene.whitespace',
  'lucene.keyword'
]

function splitPaths(text: string): string[] {
  return text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function SearchIndexDialog({
  tab,
  existing,
  onClose,
  onSaved
}: {
  tab: TabOf<'collection'>
  existing: SearchIndexDoc | null
  onClose: () => void
  onSaved: () => void
}): React.JSX.Element {
  const [kind, setKind] = useState<SearchKind>(existing?.type ?? 'search')
  const [name, setName] = useState(existing?.name ?? '')
  // Editing starts from the stored definition, which the form can't always represent
  const [mode, setMode] = useState<'form' | 'json'>(existing ? 'json' : 'form')
  const [json, setJson] = useState(
    existing?.latestDefinition ? toShell(existing.latestDefinition, 2) : ''
  )
  // Full-text form
  const [dynamic, setDynamic] = useState(true)
  const [textFields, setTextFields] = useState('')
  const [analyzer, setAnalyzer] = useState('lucene.standard')
  // Vector form
  const [path, setPath] = useState('embedding')
  const [dimensions, setDimensions] = useState('1536')
  const [similarity, setSimilarity] = useState('cosine')
  const [quantization, setQuantization] = useState('none')
  const [filters, setFilters] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const formDefinition = (): Record<string, unknown> => {
    if (kind === 'vectorSearch') {
      if (!path.trim()) throw new Error('Enter the path of the embedding field')
      const dims = Number(dimensions)
      if (!Number.isInteger(dims) || dims < 1) throw new Error('Enter the number of dimensions')
      return {
        fields: [
          {
            type: 'vector',
            path: path.trim(),
            numDimensions: dims,
            similarity,
            ...(quantization !== 'none' && { quantization })
          },
          ...splitPaths(filters).map((p) => ({ type: 'filter', path: p }))
        ]
      }
    }
    const fields = splitPaths(textFields)
    if (!dynamic && !fields.length)
      throw new Error('Enter the fields to index, or turn on dynamic mapping')
    return {
      analyzer,
      mappings: {
        dynamic,
        ...(fields.length && {
          fields: Object.fromEntries(fields.map((f) => [f, { type: 'string' }]))
        })
      }
    }
  }

  const switchMode = (next: 'form' | 'json'): void => {
    if (next === 'json') {
      try {
        setJson(toShell(formDefinition(), 2))
      } catch {
        // Leave whatever was typed before
      }
    }
    setError(null)
    setMode(next)
  }

  const save = async (): Promise<void> => {
    setError(null)
    try {
      const definition = mode === 'json' ? parseShellValue(json) : formDefinition()
      if (!definition || typeof definition !== 'object') throw new Error('Enter a definition')
      const indexName = name.trim() || (kind === 'vectorSearch' ? 'vector_index' : 'default')
      setBusy(true)
      await api.mongo(tab.connectionId, '__meta', {
        op: 'runCommand',
        database: tab.database,
        command: existing
          ? { updateSearchIndex: tab.collection, name: existing.name, definition }
          : {
              createSearchIndexes: tab.collection,
              indexes: [{ name: indexName, type: kind, definition }]
            }
      })
      toast(existing ? `Updating ${existing.name}` : `Building ${indexName}`)
      onSaved()
      onClose()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title={existing ? `Edit search index ${existing.name}` : 'Create search index'}
      description={`${tab.database}.${tab.collection}`}
      onClose={onClose}
      width="lg"
      footer={
        <>
          {error && (
            <p className="mr-auto max-w-[60%] truncate text-xs text-danger" title={error}>
              {error}
            </p>
          )}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy}>
            {existing ? 'Save' : 'Create'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {!existing && (
          <div className="flex items-center justify-between gap-3">
            <Segmented
              value={kind}
              onChange={setKind}
              options={[
                { value: 'search', label: 'Full-text search' },
                { value: 'vectorSearch', label: 'Vector search' }
              ]}
            />
            <Segmented
              size="sm"
              value={mode}
              onChange={switchMode}
              options={[
                { value: 'form', label: 'Form' },
                { value: 'json', label: 'JSON' }
              ]}
            />
          </div>
        )}
        {!existing && (
          <Field label="Name" hint="Queries pick the index by this name">
            <Input
              mono
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={kind === 'vectorSearch' ? 'vector_index' : 'default'}
            />
          </Field>
        )}
        {mode === 'json' ? (
          <Field
            label="Definition"
            hint={
              kind === 'vectorSearch'
                ? '{ fields: [{ type: "vector", path, numDimensions, similarity }, { type: "filter", path }] }'
                : '{ mappings: { dynamic: true, fields: { … } }, analyzer: "lucene.standard" }'
            }
          >
            <Textarea
              mono
              className="min-h-56"
              value={json}
              onChange={(e) => setJson(e.target.value)}
            />
          </Field>
        ) : kind === 'vectorSearch' ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Embedding field" hint="Path to an array of numbers">
                <Input mono value={path} onChange={(e) => setPath(e.target.value)} />
              </Field>
              <Field label="Dimensions" hint="Must match the embedding model">
                <Input
                  value={dimensions}
                  onChange={(e) => setDimensions(e.target.value.replace(/\D/g, ''))}
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Similarity">
                <Select value={similarity} onChange={(e) => setSimilarity(e.target.value)}>
                  <option value="cosine">cosine</option>
                  <option value="dotProduct">dotProduct</option>
                  <option value="euclidean">euclidean</option>
                </Select>
              </Field>
              <Field label="Quantization">
                <Select value={quantization} onChange={(e) => setQuantization(e.target.value)}>
                  <option value="none">none</option>
                  <option value="scalar">scalar</option>
                  <option value="binary">binary</option>
                </Select>
              </Field>
            </div>
            <Field
              label="Filter fields"
              hint="Comma-separated paths you can pre-filter on in $vectorSearch"
            >
              <Input
                mono
                value={filters}
                onChange={(e) => setFilters(e.target.value)}
                placeholder="category, year"
              />
            </Field>
          </>
        ) : (
          <>
            <Toggle
              checked={dynamic}
              onChange={setDynamic}
              label="Dynamic mapping"
              description="Index every field of a supported type"
            />
            <Field
              label={dynamic ? 'Also map as text' : 'Text fields'}
              hint="Comma-separated paths indexed as strings; use JSON for other field types"
            >
              <Input
                mono
                value={textFields}
                onChange={(e) => setTextFields(e.target.value)}
                placeholder="title, plot"
              />
            </Field>
            <Field label="Analyzer">
              <Select value={analyzer} onChange={(e) => setAnalyzer(e.target.value)}>
                {ANALYZERS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </Select>
            </Field>
          </>
        )}
      </div>
    </Modal>
  )
}
