import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Group, Panel, Separator } from 'react-resizable-panels'
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Code2,
  Eye,
  Play,
  Plus,
  Trash2
} from 'lucide-react'
import {
  FORM_OPERATORS,
  STAGE_INFO,
  fieldPaths,
  formText,
  parsePipeline,
  stageForm,
  type StageCategory,
  type StageForm
} from '@/lib/aggregation'
import { api, type MongoOutput } from '@/lib/api'
import { cn } from '@/lib/cn'
import { parseShellValue, toShell } from '@/lib/ejson'
import { shellCollection } from '@/lib/mongo-shell'
import { formatDuration } from '@/lib/format'
import { queries } from '@/lib/queries'
import { settingsStore } from '@/lib/settings'
import { createPersistentStore } from '@/lib/store'
import { errorMessage } from '@/lib/toast'
import { confirm, newQueryTab, type TabOf } from '@/lib/workspace'
import { showMenuAt, type MenuItem } from '@/components/ContextMenu'
import { CodeEditor } from '@/components/editor/CodeEditor'
import {
  Badge,
  Button,
  EmptyState,
  ErrorText,
  Modal,
  ProgressBar,
  Segmented,
  Switch,
  Textarea
} from '@/components/ui'
import { DocumentsView, type DocumentsMode } from './DocumentsView'
import { StageFormEditor, type FieldLists } from './StageFormEditor'

interface Stage {
  id: string
  operator: string
  body: string
  enabled: boolean
  /** Code editor instead of the form; the form is used whenever it can show the stage */
  code?: boolean
  collapsed?: boolean
}

const TEMPLATES: Record<string, string> = {
  $match: '{}',
  $project: '{ _id: 0 }',
  $group: '{ _id: null, count: { $sum: 1 } }',
  $sort: '{ _id: 1 }',
  $limit: '20',
  $skip: '0',
  $unwind: "'$items'",
  $lookup: "{ from: '', localField: '', foreignField: '_id', as: '' }",
  $addFields: '{}',
  $set: '{}',
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
const CATEGORIES: StageCategory[] = ['Filter & shape', 'Group & sort', 'Join & reshape', 'Output']
/** Documents each stage preview shows */
const SAMPLE = 10

const pipelinesStore = createPersistentStore<Record<string, Stage[]>>('dbms.pipelines.v1', {})
const autoPreviewStore = createPersistentStore('dbms.pipelines.autoPreview.v1', true)

function newStage(operator = '$match'): Stage {
  return {
    id: crypto.randomUUID().slice(0, 8),
    operator,
    body: TEMPLATES[operator] ?? '{}',
    enabled: true
  }
}

interface StagePreview {
  /** Pipeline text the preview was run for, to drop stale results */
  sig: string
  docs?: unknown[]
  error?: string
  elapsedMs?: number
}

export function AggregationView({ tab }: { tab: TabOf<'collection'> }): React.JSX.Element {
  const key = `${tab.connectionId}/${tab.database}/${tab.collection}`
  const stages = pipelinesStore.use()[key] ?? [newStage()]
  const setStages = (next: Stage[]): void => pipelinesStore.set((p) => ({ ...p, [key]: next }))
  const { maxRows } = settingsStore.use()
  const autoPreview = autoPreviewStore.use()
  const [selected, setSelected] = useState<number | null>(null)
  const [output, setOutput] = useState<{ out: MongoOutput; label: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [mode, setMode] = useState<DocumentsMode>('list')
  const [previews, setPreviews] = useState<Record<string, StagePreview>>({})
  const [inputFields, setInputFields] = useState<string[]>([])
  const [pasting, setPasting] = useState(false)
  const collections = useQuery(queries.objects(tab.connectionId, tab.database, null))

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
  const insert = (at: number, operator: string): void => {
    const next = [...stages]
    next.splice(at, 0, newStage(operator))
    setStages(next)
    setSelected(at)
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

  // Fields of the collection itself, for the first stage's pickers
  useEffect(() => {
    let live = true
    api
      .mongo(tab.connectionId, `${tab.id}:preview`, {
        op: 'aggregate',
        database: tab.database,
        collection: tab.collection,
        pipeline: [{ $limit: 100 }]
      })
      .then((out) => live && setInputFields(fieldPaths(out.documents)))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [tab.connectionId, tab.id, tab.database, tab.collection])

  // Per-stage output samples, rerun shortly after the pipeline changes
  const sigs = stages.map((_, i) => {
    try {
      return JSON.stringify(pipelineUpTo(i, true))
    } catch {
      return null
    }
  })
  const sigKey = sigs.join('\n')
  const latest = useRef<Record<string, string | null>>({})
  latest.current = Object.fromEntries(stages.map((s, i) => [s.id, sigs[i]]))
  useEffect(() => {
    if (!autoPreview) return
    const timer = setTimeout(() => {
      stages.forEach((stage, i) => {
        const sig = sigs[i]
        if (sig === null || !stage.enabled || previews[stage.id]?.sig === sig) return
        api
          .mongo(
            tab.connectionId,
            `${tab.id}:preview`,
            {
              op: 'aggregate',
              database: tab.database,
              collection: tab.collection,
              pipeline: [...(JSON.parse(sig) as unknown[]), { $limit: SAMPLE }]
            },
            { maxRows: SAMPLE }
          )
          .then(
            (out) => ({ sig, docs: out.documents, elapsedMs: out.elapsedMs }),
            (e) => ({ sig, error: errorMessage(e) })
          )
          .then((preview: StagePreview) => {
            // A slower, older request mustn't replace a newer result
            if (latest.current[stage.id] !== sig) return
            setPreviews((p) => ({ ...p, [stage.id]: preview }))
          })
      })
    }, 600)
    return () => clearTimeout(timer)
    // sigKey covers every input that changes a preview
  }, [sigKey, autoPreview])

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

  const stageMenu = (at: number): MenuItem[] =>
    CATEGORIES.flatMap((category): MenuItem[] => [
      { heading: category },
      ...OPERATORS.filter((op) => STAGE_INFO[op]?.category === category).map((op): MenuItem => ({
        label: `${op}  ·  ${STAGE_INFO[op].description}`,
        danger: WRITE_STAGES.has(op),
        onSelect: () => insert(at, op)
      }))
    ])

  /** Pickers for stage i list the fields the previous stage outputs. */
  const listsFor = (i: number): string[] => {
    for (let j = i - 1; j >= 0; j--) {
      if (!stages[j].enabled) continue
      const docs = previews[stages[j].id]?.docs
      return docs?.length ? fieldPaths(docs) : inputFields
    }
    return inputFields
  }

  return (
    <Group orientation="horizontal" className="min-h-0 flex-1">
      <Panel id="stages" defaultSize="55%" minSize={360}>
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
            <label
              className="ml-1 flex items-center gap-1.5 text-[11px] text-muted"
              title={`Show the first ${SAMPLE} documents each stage outputs, updated as you edit`}
            >
              <Switch checked={autoPreview} onChange={(on) => autoPreviewStore.set(on)} />
              Stage previews
            </label>
            <div className="flex-1" />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setPasting(true)}
              title="Replace the stages with a pasted pipeline"
            >
              <ClipboardPaste className="size-3.5" /> Paste
            </Button>
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
              onClick={(e) => showMenuAt(e.currentTarget, stageMenu(stages.length))}
            >
              <Plus className="size-3.5" /> Stage
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto bg-canvas p-2">
            {stages.map((stage, i) => (
              <div key={stage.id}>
                {i > 0 && <InsertGap onClick={(el) => showMenuAt(el, stageMenu(i))} />}
                <StageCard
                  index={i}
                  stage={stage}
                  count={stages.length}
                  selected={selected === i}
                  parseError={parsed[i].error}
                  preview={
                    autoPreview && previews[stage.id]?.sig === sigs[i]
                      ? previews[stage.id]
                      : undefined
                  }
                  previewing={autoPreview && stage.enabled && sigs[i] !== null}
                  fields={listsFor(i)}
                  collections={collections.data?.map((c) => c.name) ?? []}
                  onSelect={() => setSelected(i)}
                  onChange={(patch) => update(i, patch)}
                  onMove={(d) => move(i, d)}
                  onRemove={() => setStages(stages.filter((_, j) => j !== i))}
                  onPreview={() => void run(i, true)}
                />
              </div>
            ))}
            {!stages.length && (
              <EmptyState title="Empty pipeline">
                Add a stage to start building an aggregation.
              </EmptyState>
            )}
            {stages.length > 0 && (
              <InsertGap last onClick={(el) => showMenuAt(el, stageMenu(stages.length))} />
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
      <Panel id="output" defaultSize="45%" minSize={280}>
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
      {pasting && (
        <PastePipeline
          onClose={() => setPasting(false)}
          onPaste={(list) => {
            setStages(list.map((s) => ({ ...newStage(s.operator), body: s.body })))
            setPasting(false)
          }}
        />
      )}
    </Group>
  )
}

function InsertGap({
  onClick,
  last
}: {
  onClick: (el: HTMLElement) => void
  last?: boolean
}): React.JSX.Element {
  return (
    <div className={cn('group flex justify-center', last ? 'py-2' : 'h-4 items-center')}>
      <button
        type="button"
        title="Insert a stage here"
        onClick={(e) => onClick(e.currentTarget)}
        className={cn(
          'flex items-center gap-1 rounded-full border border-dashed border-line-strong px-2 text-[11px] text-muted transition-opacity hover:border-accent/50 hover:text-bright',
          last ? 'h-6' : 'h-4 opacity-0 group-hover:opacity-100'
        )}
      >
        <Plus className="size-3" /> {last && 'Add stage'}
      </button>
    </div>
  )
}

function StageCard({
  index,
  stage,
  count,
  selected,
  parseError,
  preview,
  previewing,
  fields,
  collections,
  onSelect,
  onChange,
  onMove,
  onRemove,
  onPreview
}: {
  index: number
  stage: Stage
  count: number
  selected: boolean
  parseError: string | null
  preview: StagePreview | undefined
  previewing: boolean
  fields: string[]
  collections: string[]
  onSelect: () => void
  onChange: (patch: Partial<Stage>) => void
  onMove: (d: number) => void
  onRemove: () => void
  onPreview: () => void
}): React.JSX.Element {
  // The form keeps rows the body can't hold yet (an empty new condition), so
  // it's reused while the body is still the text it last wrote
  const [draft, setDraft] = useState<{ operator: string; body: string; form: StageForm } | null>(
    null
  )
  const form = useMemo(() => {
    if (draft && draft.operator === stage.operator && draft.body === stage.body) return draft.form
    if (!FORM_OPERATORS.has(stage.operator)) return null
    try {
      return stageForm(stage.operator, parseShellValue(stage.body))
    } catch {
      return null
    }
  }, [draft, stage.operator, stage.body])
  const showForm = !stage.code && form !== null
  const lists: FieldLists = {
    fields: `agg-fields-${stage.id}`,
    refs: `agg-refs-${stage.id}`,
    collections: `agg-colls-${stage.id}`
  }
  const info = STAGE_INFO[stage.operator]

  return (
    <div
      onMouseDown={onSelect}
      className={cn(
        'rounded-lg border bg-panel transition-colors',
        selected ? 'border-accent/50' : 'border-line',
        !stage.enabled && 'opacity-50'
      )}
    >
      <div
        className={cn(
          'flex items-center gap-1.5 px-2 py-1.5',
          !stage.collapsed && 'border-b border-line'
        )}
      >
        <Button
          size="icon-sm"
          variant="ghost"
          title={stage.collapsed ? 'Expand' : 'Collapse'}
          onClick={() => onChange({ collapsed: !stage.collapsed })}
        >
          {stage.collapsed ? (
            <ChevronRight className="size-3.5" />
          ) : (
            <ChevronDown className="size-3.5" />
          )}
        </Button>
        <span className="w-4 text-center text-[11px] text-faint tabular-nums">{index + 1}</span>
        <input
          list="aggregation-operators"
          value={stage.operator}
          onChange={(e) => {
            const operator = e.target.value
            const unchanged = !stage.body.trim() || stage.body === TEMPLATES[stage.operator]
            onChange({
              operator,
              ...(unchanged && TEMPLATES[operator] ? { body: TEMPLATES[operator] } : {})
            })
          }}
          spellCheck={false}
          className={cn(
            'h-6 w-36 rounded border border-line-strong bg-canvas px-2 font-mono text-[12px] focus:border-accent/50 focus:outline-none',
            WRITE_STAGES.has(stage.operator) ? 'text-warn' : 'text-syn-keyword'
          )}
        />
        {parseError ? (
          <span className="min-w-0 truncate text-[11px] text-danger" title={parseError}>
            {parseError}
          </span>
        ) : (
          info && (
            <span className="min-w-0 truncate text-[11px] text-faint">{info.description}</span>
          )
        )}
        <div className="flex-1" />
        {preview?.docs && (
          <Badge title={`Sample output, ${formatDuration(preview.elapsedMs ?? 0)}`}>
            {preview.docs.length < SAMPLE ? preview.docs.length : `${SAMPLE}+`} docs
          </Badge>
        )}
        {preview?.error && <Badge tone="danger">error</Badge>}
        <Segmented
          size="sm"
          value={showForm ? 'form' : 'code'}
          onChange={(m) => onChange({ code: m === 'code' })}
          options={[
            {
              value: 'form',
              label: 'Form',
              title: form ? 'Edit with a form' : 'The form can’t show this stage; edit it as code'
            },
            { value: 'code', label: 'Code' }
          ]}
        />
        <Button
          size="icon-sm"
          variant="ghost"
          title="Preview output of this stage"
          onClick={onPreview}
        >
          <Eye className="size-3.5" />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          title="Move up"
          disabled={index === 0}
          onClick={() => onMove(-1)}
        >
          <ArrowUp className="size-3.5" />
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          title="Move down"
          disabled={index === count - 1}
          onClick={() => onMove(1)}
        >
          <ArrowDown className="size-3.5" />
        </Button>
        <Switch
          checked={stage.enabled}
          onChange={(enabled) => onChange({ enabled })}
          label="Enabled"
        />
        <Button size="icon-sm" variant="ghost" title="Remove stage" onClick={onRemove}>
          <Trash2 className="size-3.5" />
        </Button>
      </div>
      {!stage.collapsed && (
        <>
          {showForm ? (
            <StageFormEditor
              form={form}
              lists={lists}
              onChange={(next) => {
                const body = formText(next)
                setDraft({ operator: stage.operator, body, form: next })
                onChange({ body })
              }}
            />
          ) : (
            <>
              {!stage.code && FORM_OPERATORS.has(stage.operator) && (
                <p className="border-b border-line px-2 py-1 text-[11px] text-faint">
                  This stage uses syntax the form can’t show, so it’s edited as code.
                </p>
              )}
              <div
                style={{
                  height: Math.min(260, Math.max(56, (stage.body.split('\n').length + 1) * 20))
                }}
              >
                <CodeEditor
                  value={stage.body}
                  onChange={(body) => onChange({ body })}
                  language={{ kind: 'mongo' }}
                  lineNumbers={false}
                  className="h-full"
                  fontSize={12.5}
                />
              </div>
            </>
          )}
          {previewing && <PreviewStrip preview={preview} />}
        </>
      )}
      <datalist id={lists.fields}>
        {fields.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>
      <datalist id={lists.refs}>
        {fields.map((f) => (
          <option key={f} value={`$${f}`} />
        ))}
      </datalist>
      <datalist id={lists.collections}>
        {collections.map((c) => (
          <option key={c} value={c} />
        ))}
      </datalist>
    </div>
  )
}

function PreviewStrip({ preview }: { preview: StagePreview | undefined }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  if (!preview)
    return <div className="border-t border-line px-2 py-1 text-[11px] text-faint">Previewing…</div>
  if (preview.error)
    return (
      <div className="border-t border-line px-2 py-1.5 text-[11px] break-words text-danger select-text">
        {preview.error}
      </div>
    )
  const docs = preview.docs ?? []
  const shown = open ? docs : docs.slice(0, 2)
  return (
    <div className="border-t border-line bg-canvas/40 px-2 py-1.5">
      {!docs.length ? (
        <p className="text-[11px] text-faint">No documents reach this stage’s output.</p>
      ) : (
        <div className="space-y-0.5">
          {shown.map((d, i) => (
            <p
              key={i}
              className="truncate font-mono text-[11px] text-muted select-text"
              title={toShell(d)}
            >
              {toShell(d, 0)}
            </p>
          ))}
          {docs.length > 2 && (
            <button
              type="button"
              onClick={() => setOpen(!open)}
              className="text-[11px] text-faint hover:text-bright"
            >
              {open ? 'Show fewer' : `Show ${docs.length - 2} more`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function PastePipeline({
  onClose,
  onPaste
}: {
  onClose: () => void
  onPaste: (stages: { operator: string; body: string }[]) => void
}): React.JSX.Element {
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const apply = (): void => {
    try {
      onPaste(parsePipeline(text))
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  return (
    <Modal
      title="Paste a pipeline"
      description="An array of stages, or a whole db.collection.aggregate([...]) call. It replaces the current stages."
      onClose={onClose}
      width="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={apply} disabled={!text.trim()}>
            Replace stages
          </Button>
        </>
      }
    >
      <Textarea
        mono
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          setError(null)
        }}
        placeholder="[{ $match: { status: 'active' } }, { $group: { _id: '$city', n: { $sum: 1 } } }]"
        className="min-h-48"
      />
      {error && (
        <div className="mt-2">
          <ErrorText error={error} />
        </div>
      )}
    </Modal>
  )
}
