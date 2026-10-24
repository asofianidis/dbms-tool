import { useCallback, useEffect, useState } from 'react'
import {
  CheckCircle2,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldCheck,
  Sparkles,
  Trash2
} from 'lucide-react'
import { api } from '@/lib/api'
import { parseShellValue, scalarText, toShell } from '@/lib/ejson'
import {
  readValidation,
  schemaFromSample,
  validationCommand,
  type ValidationAction,
  type ValidationLevel
} from '@/lib/mongo-collections'
import { errorMessage, toast, toastError } from '@/lib/toast'
import { confirm, type TabOf } from '@/lib/workspace'
import { CodeEditor } from '@/components/editor/CodeEditor'
import {
  Badge,
  Button,
  EmptyState,
  ErrorText,
  ProgressBar,
  Select,
  Spinner,
  Toolbar,
  ToolbarDivider
} from '@/components/ui'

const SAMPLE = 200

interface Loaded {
  type: string
  text: string
  level: ValidationLevel
  action: ValidationAction
  /** View definition, for views */
  viewOn: string | null
  pipeline: unknown
}

/** Edits the collection's validator, usually a `$jsonSchema`, through `collMod`. */
export function ValidationView({
  tab,
  readOnly
}: {
  tab: TabOf<'collection'>
  readOnly: boolean
}): React.JSX.Element {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [text, setText] = useState('')
  const [level, setLevel] = useState<ValidationLevel>('strict')
  const [action, setAction] = useState<ValidationAction>('error')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [check, setCheck] = useState<string | null>(null)

  const load = useCallback(async () => {
    setBusy(true)
    setError(null)
    setCheck(null)
    try {
      const out = await api.mongo(tab.connectionId, tab.id, {
        op: 'runCommand',
        database: tab.database,
        command: { listCollections: 1, filter: { name: tab.collection } }
      })
      const info = (out.value as { cursor?: { firstBatch?: unknown[] } })?.cursor?.firstBatch?.[0]
      if (!info) throw new Error(`${tab.collection} no longer exists`)
      const rules = readValidation(info)
      const options = ((info as { options?: Record<string, unknown> }).options ?? {}) as Record<
        string,
        unknown
      >
      const next: Loaded = {
        type: String((info as { type?: unknown }).type ?? 'collection'),
        text: rules.validator ? toShell(rules.validator) : '',
        level: rules.level,
        action: rules.action,
        viewOn: typeof options.viewOn === 'string' ? options.viewOn : null,
        pipeline: options.pipeline ?? null
      }
      setLoaded(next)
      setText(next.text)
      setLevel(next.level)
      setAction(next.action)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }, [tab.connectionId, tab.id, tab.database, tab.collection])

  useEffect(() => {
    void load()
  }, [load])

  const dirty =
    !!loaded && (text !== loaded.text || level !== loaded.level || action !== loaded.action)

  const generate = async (): Promise<void> => {
    if (
      text.trim() &&
      !(await confirm({
        title: 'Replace the current rules?',
        message: `A schema inferred from ${SAMPLE} sampled documents replaces the text in the editor. Nothing is saved until you click Save.`,
        confirmLabel: 'Replace'
      }))
    )
      return
    setBusy(true)
    try {
      const out = await api.mongo(tab.connectionId, tab.id, {
        op: 'aggregate',
        database: tab.database,
        collection: tab.collection,
        pipeline: [{ $sample: { size: SAMPLE } }]
      })
      if (!out.documents.length)
        throw new Error('The collection is empty; there is nothing to sample')
      setText(toShell({ $jsonSchema: schemaFromSample(out.documents) }))
      toast(`Inferred from ${out.documents.length} documents; review it before saving`, 'info')
    } catch (e) {
      toastError(e)
    } finally {
      setBusy(false)
    }
  }

  /** Counts documents the rules in the editor would reject. */
  const validate = async (): Promise<void> => {
    setCheck(null)
    try {
      if (!text.trim()) {
        setCheck('With no rules, every document is valid')
        return
      }
      const validator = parseShellValue(text)
      const out = await api.mongo(tab.connectionId, tab.id, {
        op: 'count',
        database: tab.database,
        collection: tab.collection,
        filter: { $nor: [validator] }
      })
      const n = Number(scalarText(out.value))
      setCheck(
        n === 0
          ? 'Every existing document passes these rules'
          : `${n.toLocaleString()} existing ${n === 1 ? 'document fails' : 'documents fail'} these rules`
      )
    } catch (e) {
      setCheck(errorMessage(e))
    }
  }

  const save = async (remove = false): Promise<void> => {
    if (
      remove &&
      !(await confirm({
        title: `Remove validation from ${tab.collection}?`,
        message: 'Inserts and updates will no longer be checked.',
        confirmLabel: 'Remove rules',
        danger: true
      }))
    )
      return
    setBusy(true)
    try {
      await api.mongo(tab.connectionId, tab.id, {
        op: 'runCommand',
        database: tab.database,
        command: validationCommand(tab.collection, remove ? '' : text, level, action)
      })
      toast(remove ? 'Validation removed' : 'Validation rules saved')
      await load()
    } catch (e) {
      toastError(e)
      setBusy(false)
    }
  }

  if (error)
    return (
      <div className="p-4">
        <ErrorText error={error} />
      </div>
    )
  if (!loaded) return <EmptyState title="Loading…" icon={<Spinner className="size-5" />} />
  if (loaded.type === 'view')
    return (
      <div className="space-y-3 p-4 text-[12.5px]">
        <p className="text-muted">
          Views can&apos;t have validation rules. This view reads{' '}
          <span className="font-mono text-bright">{loaded.viewOn}</span> through:
        </p>
        <pre className="overflow-auto rounded-lg border border-line bg-canvas p-3 font-mono text-[12px] text-fg select-text">
          {toShell(loaded.pipeline)}
        </pre>
      </div>
    )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Toolbar>
        <ShieldCheck className="ml-1 size-3.5 text-muted" />
        {loaded.text ? (
          <Badge tone={loaded.level === 'off' ? 'neutral' : 'success'}>
            {loaded.level === 'off' ? 'Rules off' : `${loaded.level}, ${loaded.action}`}
          </Badge>
        ) : (
          <Badge>No rules</Badge>
        )}
        <ToolbarDivider />
        <label className="flex items-center gap-1.5 text-[11.5px] text-muted">
          Level
          <Select
            value={level}
            onChange={(e) => setLevel(e.target.value as ValidationLevel)}
            className="w-32"
            selectClassName="h-7 text-xs"
            title="strict checks every insert and update; moderate skips updates to documents that already fail"
          >
            <option value="strict">strict</option>
            <option value="moderate">moderate</option>
            <option value="off">off</option>
          </Select>
        </label>
        <label className="flex items-center gap-1.5 text-[11.5px] text-muted">
          Action
          <Select
            value={action}
            onChange={(e) => setAction(e.target.value as ValidationAction)}
            className="w-28"
            selectClassName="h-7 text-xs"
            title="error rejects the write; warn allows it and logs a warning"
          >
            <option value="error">error</option>
            <option value="warn">warn</option>
          </Select>
        </label>
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => void generate()} disabled={busy}>
          <Sparkles className="size-3.5" /> Infer from documents
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void validate()} disabled={busy}>
          <CheckCircle2 className="size-3.5" /> Check existing
        </Button>
        <Button
          size="icon"
          variant="ghost"
          title="Revert to the saved rules"
          disabled={!dirty}
          onClick={() => {
            setText(loaded.text)
            setLevel(loaded.level)
            setAction(loaded.action)
          }}
        >
          <RotateCcw className="size-3.5" />
        </Button>
        <Button size="icon" variant="ghost" title="Reload" onClick={() => void load()}>
          <RefreshCw className="size-3.5" />
        </Button>
        {!readOnly && loaded.text && (
          <Button
            size="icon"
            variant="ghost"
            title="Remove the rules"
            className="hover:text-danger"
            onClick={() => void save(true)}
          >
            <Trash2 className="size-3.5" />
          </Button>
        )}
        {!readOnly && (
          <Button size="sm" variant="primary" onClick={() => void save()} disabled={busy || !dirty}>
            <Save className="size-3.5" /> Save
          </Button>
        )}
      </Toolbar>
      <ProgressBar active={busy} />
      <div className="min-h-0 flex-1 bg-canvas">
        <CodeEditor
          value={text}
          onChange={setText}
          language={{ kind: 'mongo' }}
          className="h-full"
          fontSize={12.5}
          readOnly={readOnly}
          placeholder={`{\n  $jsonSchema: {\n    bsonType: 'object',\n    required: ['email'],\n    properties: { email: { bsonType: 'string', pattern: '@' } }\n  }\n}`}
        />
      </div>
      <div className="flex h-6 shrink-0 items-center gap-3 border-t border-line bg-panel px-3 text-[11px] text-muted">
        {check ? (
          <span className="text-fg">{check}</span>
        ) : (
          <span className="text-faint">
            A $jsonSchema or query operators. Existing documents aren&apos;t checked until they
            change; use Check existing to count the ones that would fail.
          </span>
        )}
      </div>
    </div>
  )
}
