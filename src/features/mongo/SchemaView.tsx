import { useState } from 'react'
import { Microscope } from 'lucide-react'
import { api } from '@/lib/api'
import { cn } from '@/lib/cn'
import { bsonType, scalarText, type BsonType } from '@/lib/ejson'
import { errorMessage } from '@/lib/toast'
import type { TabOf } from '@/lib/workspace'
import { Button, EmptyState, ErrorText, ProgressBar, Segmented } from '@/components/ui'

interface FieldStats {
  path: string
  depth: number
  /** Documents (or array elements) containing the field */
  count: number
  /** How many parents were examined at this level */
  of: number
  types: Map<BsonType, number>
  samples: unknown[]
}

const TYPE_COLORS: Partial<Record<BsonType, string>> = {
  String: 'bg-syn-string',
  Int32: 'bg-syn-number',
  Int64: 'bg-syn-number',
  Double: 'bg-syn-number',
  Decimal128: 'bg-syn-number',
  ObjectId: 'bg-syn-fn',
  Date: 'bg-syn-type',
  Boolean: 'bg-syn-keyword',
  Object: 'bg-info',
  Array: 'bg-mongo',
  Null: 'bg-faint'
}

function analyze(documents: Record<string, unknown>[]): FieldStats[] {
  const stats = new Map<string, FieldStats>()
  const parents = new Map<string, number>()
  const visit = (obj: Record<string, unknown>, prefix: string, depth: number): void => {
    parents.set(prefix, (parents.get(prefix) ?? 0) + 1)
    for (const [key, value] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key
      let s = stats.get(path)
      if (!s) {
        s = { path, depth, count: 0, of: 0, types: new Map(), samples: [] }
        stats.set(path, s)
      }
      s.count++
      const type = bsonType(value)
      s.types.set(type, (s.types.get(type) ?? 0) + 1)
      if (
        s.samples.length < 3 &&
        type !== 'Object' &&
        type !== 'Array' &&
        !s.samples.some((x) => scalarText(x) === scalarText(value))
      ) {
        s.samples.push(value)
      }
      if (depth < 4) {
        if (type === 'Object') visit(value as Record<string, unknown>, path, depth + 1)
        else if (type === 'Array') {
          for (const item of (value as unknown[]).slice(0, 25)) {
            if (bsonType(item) === 'Object')
              visit(item as Record<string, unknown>, `${path}[]`, depth + 1)
          }
        }
      }
    }
  }
  for (const doc of documents) visit(doc, '', 0)
  for (const s of stats.values()) {
    const parent = s.path.includes('.') ? s.path.slice(0, s.path.lastIndexOf('.')) : ''
    s.of = parents.get(parent) ?? documents.length
  }
  return [...stats.values()].sort((a, b) => a.path.localeCompare(b.path))
}

export function SchemaView({ tab }: { tab: TabOf<'collection'> }): React.JSX.Element {
  const [size, setSize] = useState<'100' | '1000' | '5000'>('1000')
  const [fields, setFields] = useState<FieldStats[] | null>(null)
  const [sampled, setSampled] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const run = async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      const out = await api.mongo(
        tab.connectionId,
        tab.id,
        {
          op: 'aggregate',
          database: tab.database,
          collection: tab.collection,
          pipeline: [{ $sample: { size: Number(size) } }]
        },
        { maxRows: Number(size) }
      )
      setSampled(out.documents.length)
      setFields(analyze(out.documents))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
        <span className="text-[12px] text-muted">Sample</span>
        <Segmented
          size="sm"
          value={size}
          onChange={setSize}
          options={[
            { value: '100', label: '100' },
            { value: '1000', label: '1,000' },
            { value: '5000', label: '5,000' }
          ]}
        />
        <span className="text-[12px] text-muted">documents</span>
        <Button size="sm" variant="primary" onClick={() => void run()} disabled={loading}>
          <Microscope className="size-3.5" /> Analyze
        </Button>
        {fields && (
          <span className="ml-auto text-[11.5px] text-muted">
            {fields.length} fields in {sampled.toLocaleString()} sampled documents
          </span>
        )}
      </div>
      <ProgressBar active={loading} />
      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <div className="p-4">
            <ErrorText error={error} />
          </div>
        ) : !fields ? (
          <EmptyState
            icon={<Microscope className="size-6" />}
            title="Analyze the collection's shape"
            actions={
              <Button size="sm" variant="primary" onClick={() => void run()}>
                Analyze
              </Button>
            }
          >
            Samples random documents with $sample and reports every field path, how often it appears
            and which BSON types it holds.
          </EmptyState>
        ) : (
          <table className="w-full text-left text-[12.5px]">
            <thead className="sticky top-0 z-10 bg-panel text-[11px] text-muted">
              <tr className="border-b border-line">
                <th className="px-3 py-1.5 font-medium">Field</th>
                <th className="w-40 px-3 py-1.5 font-medium">Present</th>
                <th className="px-3 py-1.5 font-medium">Types</th>
                <th className="px-3 py-1.5 font-medium">Examples</th>
              </tr>
            </thead>
            <tbody>
              {fields.map((f) => {
                const pct = f.of ? Math.round((f.count / f.of) * 100) : 0
                const types = [...f.types.entries()].sort((a, b) => b[1] - a[1])
                return (
                  <tr key={f.path} className="border-b border-line/50 hover:bg-hover/40">
                    <td
                      className="px-3 py-1.5 font-mono whitespace-nowrap"
                      style={{ paddingLeft: 12 + f.depth * 16 }}
                    >
                      <span className="text-faint">
                        {f.path.includes('.') ? f.path.slice(0, f.path.lastIndexOf('.') + 1) : ''}
                      </span>
                      <span className="text-syn-prop">
                        {f.path.slice(f.path.lastIndexOf('.') + 1)}
                      </span>
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-20 overflow-hidden rounded-full bg-line-strong">
                          <div
                            className={cn(
                              'h-full rounded-full',
                              pct === 100 ? 'bg-ok' : pct >= 50 ? 'bg-accent' : 'bg-warn'
                            )}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className="text-[11px] text-muted tabular-nums">{pct}%</span>
                      </div>
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <div className="flex h-1.5 w-16 overflow-hidden rounded-full bg-line-strong">
                          {types.map(([t, n]) => (
                            <div
                              key={t}
                              className={TYPE_COLORS[t] ?? 'bg-muted'}
                              style={{ width: `${(n / f.count) * 100}%` }}
                            />
                          ))}
                        </div>
                        {types.map(([t, n]) => (
                          <span key={t} className="text-[11px] text-fg">
                            {t}
                            {types.length > 1 && (
                              <span className="text-faint">
                                {' '}
                                {Math.round((n / f.count) * 100)}%
                              </span>
                            )}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="max-w-96 truncate px-3 py-1.5 font-mono text-[11.5px] text-muted select-text">
                      {f.samples.map((s) => scalarText(s)).join(', ')}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
