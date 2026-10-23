import { useMemo, useState } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { ArrowDown, ArrowUp, Code2, Eye, Play, Plus, Trash2 } from 'lucide-react'
import { api, type MongoOutput } from '@/lib/api'
import { cn } from '@/lib/cn'
import { parseShellValue } from '@/lib/ejson'
import { shellCollection } from '@/lib/mongo-shell'
import { formatDuration } from '@/lib/format'
import { settingsStore } from '@/lib/settings'
import { createPersistentStore } from '@/lib/store'
import { errorMessage } from '@/lib/toast'
import { confirm, newQueryTab, type TabOf } from '@/lib/workspace'
import { CodeEditor } from '@/components/editor/CodeEditor'
import { Button, EmptyState, ErrorText, ProgressBar, Switch } from '@/components/ui'
import { DocumentsView, type DocumentsMode } from './DocumentsView'

interface Stage {
  id: string
  operator: string
  body: string
  enabled: boolean
}

const TEMPLATES: Record<string, string> = {
  $match: "{ status: 'active' }",
  $project: '{ _id: 0, name: 1 }',
  $group: "{ _id: '$field', count: { $sum: 1 } }",
  $sort: '{ count: -1 }',
  $limit: '20',
  $skip: '0',
  $unwind: "'$items'",
  $lookup:
    "{\n  from: 'other',\n  localField: 'otherId',\n  foreignField: '_id',\n  as: 'other'\n}",
  $addFields: "{ total: { $sum: '$items.price' } }",
  $set: "{ total: { $sum: '$items.price' } }",
  $unset: "'field'",
  $count: "'total'",
  $sample: '{ size: 10 }',
  $replaceRoot: "{ newRoot: '$field' }",
  $replaceWith: "'$field'",
  $sortByCount: "'$field'",
  $facet: "{\n  byStatus: [{ $sortByCount: '$status' }],\n  total: [{ $count: 'n' }]\n}",
  $bucket: "{ groupBy: '$price', boundaries: [0, 100, 1000], default: 'other' }",
  $unionWith: "{ coll: 'other' }",
  $graphLookup:
    "{ from: 'c', startWith: '$parent', connectFromField: 'parent', connectToField: '_id', as: 'ancestors' }",
  $densify: "{ field: 'date', range: { step: 1, unit: 'day', bounds: 'full' } }",
  $setWindowFields:
    "{ sortBy: { date: 1 }, output: { running: { $sum: '$amount', window: { documents: ['unbounded', 'current'] } } } }",
  $out: "'output_collection'",
  $merge: "{ into: 'output_collection' }"
}

const OPERATORS = Object.keys(TEMPLATES)
const WRITE_STAGES = new Set(['$out', '$merge'])

const pipelinesStore = createPersistentStore<Record<string, Stage[]>>('dbms.pipelines.v1', {})

function newStage(operator = '$match'): Stage {
  return {
    id: crypto.randomUUID().slice(0, 8),
    operator,
    body: TEMPLATES[operator] ?? '{}',
    enabled: true
  }
}

export function AggregationView({ tab }: { tab: TabOf<'collection'> }): React.JSX.Element {
  const key = `${tab.connectionId}/${tab.database}/${tab.collection}`
  const stages = pipelinesStore.use()[key] ?? [newStage()]
  const setStages = (next: Stage[]): void => pipelinesStore.set((p) => ({ ...p, [key]: next }))
  const { maxRows } = settingsStore.use()
  const [selected, setSelected] = useState<number | null>(null)
  const [output, setOutput] = useState<{ out: MongoOutput; label: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [mode, setMode] = useState<DocumentsMode>('list')

  const parsed = useMemo(
    () =>
      stages.map((s) => {
        try {
          return { stage: { [s.operator]: parseShellValue(s.body) }, error: null as string | null }
        } catch (e) {
          return { stage: null, error: errorMessage(e) }
        }
      }),
    [stages]
  )

  const update = (i: number, patch: Partial<Stage>): void =>
    setStages(stages.map((s, j) => (j === i ? { ...s, ...patch } : s)))
  const move = (i: number, d: number): void => {
    const next = [...stages]
    const [s] = next.splice(i, 1)
    next.splice(Math.max(0, Math.min(next.length, i + d)), 0, s)
    setStages(next)
  }

  const pipelineUpTo = (end: number, preview: boolean): unknown[] => {
    const list: unknown[] = []
    for (let i = 0; i <= end && i < stages.length; i++) {
      if (!stages[i].enabled) continue
      if (parsed[i].error)
        throw new Error(`Stage ${i + 1} (${stages[i].operator}): ${parsed[i].error}`)
      // Previews never write
      if (preview && WRITE_STAGES.has(stages[i].operator)) continue
      list.push(parsed[i].stage)
    }
    return list
  }

  const run = async (end: number, preview: boolean): Promise<void> => {
    setError(null)
    let pipeline: unknown[]
    try {
      pipeline = pipelineUpTo(end, preview)
    } catch (e) {
      setError(errorMessage(e))
      return
    }
    if (!preview && stages.some((s) => s.enabled && WRITE_STAGES.has(s.operator))) {
      const ok = await confirm({
        title: 'Run a pipeline that writes?',
        message: 'This pipeline ends in $out or $merge and will write to a collection.',
        confirmLabel: 'Run pipeline',
        danger: true
      })
      if (!ok) return
    }
    if (preview) pipeline.push({ $limit: 20 })
    setRunning(true)
    try {
      const out = await api.mongo(
        tab.connectionId,
        tab.id,
        { op: 'aggregate', database: tab.database, collection: tab.collection, pipeline },
        { maxRows }
      )
      setOutput({
        out,
        label: preview ? `Preview after stage ${end + 1} (first 20)` : 'Full pipeline'
      })
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setRunning(false)
    }
  }

  const exportToShell = (): void => {
    const body = stages
      .filter((s) => s.enabled)
      .map((s) => `  { ${s.operator}: ${s.body.replace(/\n/g, '\n    ')} }`)
      .join(',\n')
    newQueryTab(
      tab.connectionId,
      tab.database,
      `${shellCollection(tab.collection)}.aggregate([\n${body}\n])`
    )
  }

  return (
    <Group orientation="horizontal" className="min-h-0 flex-1">
      <Panel id="stages" defaultSize="50%" minSize={320}>
        <div className="flex h-full flex-col">
          <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-line bg-panel px-2">
            <Button
              size="sm"
              variant="primary"
              onClick={() => void run(stages.length - 1, false)}
              disabled={running}
            >
              <Play className="size-3.5 fill-current" /> Run
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void run(stages.length - 1, true)}
              disabled={running}
            >
              <Eye className="size-3.5" /> Preview
            </Button>
            <div className="flex-1" />
            <Button
              size="sm"
              variant="ghost"
              onClick={exportToShell}
              title="Open as db.collection.aggregate([...]) in a shell tab"
            >
              <Code2 className="size-3.5" /> Shell
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                setStages([...stages, newStage(stages.length ? '$project' : '$match')])
              }
            >
              <Plus className="size-3.5" /> Stage
            </Button>
          </div>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto bg-canvas p-2">
            {stages.map((stage, i) => (
              <div
                key={stage.id}
                onMouseDown={() => setSelected(i)}
                className={cn(
                  'rounded-lg border bg-panel transition-colors',
                  selected === i ? 'border-accent/50' : 'border-line',
                  !stage.enabled && 'opacity-50'
                )}
              >
                <div className="flex items-center gap-1.5 border-b border-line px-2 py-1.5">
                  <span className="w-5 text-center text-[11px] text-faint tabular-nums">
                    {i + 1}
                  </span>
                  <input
                    list="aggregation-operators"
                    value={stage.operator}
                    onChange={(e) => {
                      const operator = e.target.value
                      const unchanged =
                        !stage.body.trim() || stage.body === TEMPLATES[stage.operator]
                      update(i, {
                        operator,
                        ...(unchanged && TEMPLATES[operator] ? { body: TEMPLATES[operator] } : {})
                      })
                    }}
                    spellCheck={false}
                    className={cn(
                      'h-6 w-40 rounded border border-line-strong bg-canvas px-2 font-mono text-[12px] focus:border-accent/50 focus:outline-none',
                      WRITE_STAGES.has(stage.operator) ? 'text-warn' : 'text-syn-keyword'
                    )}
                  />
                  {parsed[i].error && (
                    <span className="truncate text-[11px] text-danger" title={parsed[i].error!}>
                      {parsed[i].error}
                    </span>
                  )}
                  <div className="flex-1" />
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    title="Preview output of this stage"
                    onClick={() => void run(i, true)}
                  >
                    <Eye className="size-3.5" />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    title="Move up"
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                  >
                    <ArrowUp className="size-3.5" />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    title="Move down"
                    disabled={i === stages.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    <ArrowDown className="size-3.5" />
                  </Button>
                  <Switch
                    checked={stage.enabled}
                    onChange={(enabled) => update(i, { enabled })}
                    label="Enabled"
                  />
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    title="Remove stage"
                    onClick={() => setStages(stages.filter((_, j) => j !== i))}
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
                <div
                  style={{
                    height: Math.min(260, Math.max(56, (stage.body.split('\n').length + 1) * 20))
                  }}
                >
                  <CodeEditor
                    value={stage.body}
                    onChange={(body) => update(i, { body })}
                    language={{ kind: 'mongo' }}
                    lineNumbers={false}
                    className="h-full"
                    fontSize={12.5}
                  />
                </div>
              </div>
            ))}
            {!stages.length && (
              <EmptyState title="Empty pipeline">
                Add a stage to start building an aggregation.
              </EmptyState>
            )}
            <datalist id="aggregation-operators">
              {OPERATORS.map((op) => (
                <option key={op} value={op} />
              ))}
            </datalist>
          </div>
        </div>
      </Panel>
      <Separator />
      <Panel id="output" defaultSize="50%" minSize={280}>
        <div className="flex h-full flex-col">
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line bg-panel px-3 text-[12px] text-muted">
            {output ? (
              <>
                <span className="text-fg">{output.label}</span>
                <span className="tabular-nums">
                  {output.out.documents.length.toLocaleString()} docs
                </span>
                <span className="text-faint">{formatDuration(output.out.elapsedMs)}</span>
              </>
            ) : (
              'Output'
            )}
          </div>
          <ProgressBar active={running} />
          <div className="min-h-0 flex-1">
            {error ? (
              <div className="p-4">
                <ErrorText error={error} />
              </div>
            ) : output ? (
              <DocumentsView documents={output.out.documents} mode={mode} onModeChange={setMode} />
            ) : (
              <EmptyState title="Preview a stage or run the pipeline">
                Previews add <span className="font-mono">$limit: 20</span> and skip{' '}
                <span className="font-mono">$out</span> / <span className="font-mono">$merge</span>.
              </EmptyState>
            )}
          </div>
        </div>
      </Panel>
    </Group>
  )
}
