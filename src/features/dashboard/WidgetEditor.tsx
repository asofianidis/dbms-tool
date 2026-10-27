import { useRef, useState } from 'react'
import { Check, LayoutGrid, Play } from 'lucide-react'
import type { Engine } from '@/lib/api'
import { cn } from '@/lib/cn'
import {
  guessMapping,
  numericColumns,
  resolveColumns,
  type Widget,
  type WidgetKind,
  type WidgetSpan
} from '@/lib/dashboards'
import { ENGINES } from '@/lib/engines'
import { MOD } from '@/lib/keys'
import { settingsStore } from '@/lib/settings'
import { errorMessage } from '@/lib/toast'
import { CodeEditor, type CodeEditorHandle } from '@/components/editor/CodeEditor'
import {
  Button,
  EmptyState,
  ErrorText,
  Field,
  Input,
  Modal,
  Segmented,
  Select,
  Spinner
} from '@/components/ui'
import { runWidgetQuery, type WidgetResult } from './run'
import { WidgetBody } from './WidgetBody'

const KIND_OPTIONS: { value: WidgetKind; label: string }[] = [
  { value: 'stat', label: 'Number' },
  { value: 'bar', label: 'Bar' },
  { value: 'line', label: 'Line' },
  { value: 'table', label: 'Table' }
]

const SPAN_OPTIONS: { value: `${WidgetSpan}`; label: string }[] = [
  { value: '1', label: '¼' },
  { value: '2', label: '½' },
  { value: '3', label: '¾' },
  { value: '4', label: 'Full' }
]

const SQL_EXAMPLE = `SELECT status, count(*) AS orders
FROM orders
GROUP BY status
ORDER BY orders DESC`

const MONGO_EXAMPLE = `db.orders.aggregate([
  { $group: { _id: "$status", orders: { $sum: 1 } } },
  { $sort: { orders: -1 } }
])`

export function WidgetEditor({
  initial,
  engine,
  connectionId,
  database,
  session,
  isNew,
  assistant = false,
  onSave,
  onClose
}: {
  initial: Widget
  engine: Engine
  connectionId: string
  database: string
  /** Session key previews run on, shared with the dashboard's widgets */
  session: string
  isNew: boolean
  /** The dashboard was designed by the AI assistant: previews run with its checks too */
  assistant?: boolean
  onSave: (widget: Widget) => void
  onClose: () => void
}): React.JSX.Element {
  const settings = settingsStore.use()
  const editor = useRef<CodeEditorHandle>(null)
  const [draft, setDraft] = useState(initial)
  const [result, setResult] = useState<WidgetResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  // A new widget follows the shape of its first result until the kind is chosen by hand
  const kindChosen = useRef(!isNew)
  const patch = (p: Partial<Widget>): void => setDraft((d) => ({ ...d, ...p }))
  const dialect = ENGINES[engine].dialect

  const preview = async (): Promise<void> => {
    const query = editor.current?.text() ?? draft.query
    if (!query.trim() || running) return
    setRunning(true)
    setError(null)
    try {
      const out = await runWidgetQuery(connectionId, session, database, query, { assistant })
      setResult(out)
      setDraft((d) => {
        if (d.x || d.y.length) return d
        const guess = guessMapping(out.set)
        return {
          ...d,
          x: guess.x,
          y: guess.y,
          ...(kindChosen.current
            ? {}
            : { kind: guess.kind, span: guess.kind === 'stat' ? 1 : d.span })
        }
      })
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setRunning(false)
    }
  }

  const set = result?.set
  const numeric = set ? numericColumns(set) : []
  const resolved = set ? resolveColumns(set, draft) : null
  const charted = draft.kind !== 'table'

  const save = (): void => {
    const query = editor.current?.text() ?? draft.query
    onSave({
      ...draft,
      query,
      title: draft.title.trim() || resolved?.y[0] || 'Untitled widget'
    })
  }

  return (
    <Modal
      title={isNew ? 'Add widget' : 'Edit widget'}
      description="Widgets run read-only queries and refresh with the dashboard."
      icon={<LayoutGrid className="mt-0.5 size-4 text-accent" />}
      width="2xl"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={!draft.query.trim()}>
            {isNew ? 'Add widget' : 'Save widget'}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-5">
        <div className="space-y-4">
          <Field label="Title">
            <Input
              value={draft.title}
              onChange={(e) => patch({ title: e.target.value })}
              placeholder="e.g. Orders by status"
            />
          </Field>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted">
                {engine === 'mongo' ? 'Query (find, aggregate, count or distinct)' : 'SQL'}
              </span>
              <Button size="xs" onClick={() => void preview()} disabled={running}>
                {running ? <Spinner className="size-3" /> : <Play className="size-3" />}
                Run preview
                <span className="text-faint">{MOD}↵</span>
              </Button>
            </div>
            <div className="h-52 overflow-hidden rounded-md border border-line-strong">
              <CodeEditor
                ref={editor}
                value={draft.query}
                onChange={(query) => patch({ query })}
                language={dialect ? { kind: 'sql', dialect } : { kind: 'mongo' }}
                keys={[
                  {
                    key: 'Mod-Enter',
                    run: () => {
                      void preview()
                      return true
                    }
                  }
                ]}
                fontSize={settings.editorFontSize}
                wordWrap={settings.wordWrap}
                lineNumbers={false}
                placeholder={engine === 'mongo' ? MONGO_EXAMPLE : SQL_EXAMPLE}
                className="h-full bg-canvas"
              />
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-4">
            <div className="space-y-1.5">
              <span className="block text-xs font-medium text-muted">Show as</span>
              <Segmented
                value={draft.kind}
                options={KIND_OPTIONS}
                onChange={(kind) => {
                  kindChosen.current = true
                  patch({ kind })
                }}
              />
            </div>
            <div className="space-y-1.5">
              <span className="block text-xs font-medium text-muted">Width</span>
              <Segmented
                value={`${draft.span}`}
                options={SPAN_OPTIONS}
                onChange={(span) => patch({ span: Number(span) as WidgetSpan })}
              />
            </div>
          </div>
          {charted && set && resolved && (
            <div className="space-y-4">
              {draft.kind !== 'stat' && (
                <Field label={draft.kind === 'line' ? 'X axis' : 'Category'}>
                  <Select
                    value={resolved.x ?? ''}
                    onChange={(e) => patch({ x: e.target.value || null })}
                  >
                    <option value="">Row number</option>
                    {set.columns.map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              <div className="space-y-1.5">
                <span className="text-xs font-medium text-muted">
                  {draft.kind === 'stat' ? 'Value' : 'Values'}
                </span>
                {numeric.length ? (
                  <div className="flex flex-wrap gap-1.5">
                    {numeric
                      .filter((c) => draft.kind === 'stat' || c !== resolved.x)
                      .map((c) => {
                        const on = resolved.y.includes(c)
                        return (
                          <button
                            key={c}
                            type="button"
                            onClick={() =>
                              patch({
                                y:
                                  draft.kind === 'stat'
                                    ? [c]
                                    : on
                                      ? resolved.y.filter((v) => v !== c)
                                      : [...resolved.y, c]
                              })
                            }
                            className={cn(
                              'flex h-6 items-center gap-1 rounded-full px-2.5 text-[11.5px] ring-1 ring-inset',
                              on
                                ? 'bg-accent/10 text-bright ring-accent/40'
                                : 'text-muted ring-line-strong hover:text-bright'
                            )}
                          >
                            {on && <Check className="size-3 text-accent" />}
                            {c}
                          </button>
                        )
                      })}
                  </div>
                ) : (
                  <p className="text-[11.5px] text-faint">The result has no numeric columns.</p>
                )}
              </div>
            </div>
          )}
        </div>
        <div className="flex min-h-80 flex-col rounded-lg border border-line bg-panel p-3">
          <p className="mb-2 truncate text-[12.5px] font-medium text-bright">
            {draft.title || 'Preview'}
          </p>
          <div className={cn('min-h-0 flex-1', running && result && 'opacity-60')}>
            {error ? (
              <ErrorText error={error} />
            ) : set ? (
              <WidgetBody widget={draft} set={set} />
            ) : (
              <EmptyState title={running ? 'Running…' : 'No preview yet'}>
                {running
                  ? null
                  : `Run the query (${MOD}Enter) to preview the widget and pick its columns.`}
              </EmptyState>
            )}
          </div>
        </div>
      </div>
    </Modal>
  )
}
