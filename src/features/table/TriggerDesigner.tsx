import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, FilePlus2, Save, Trash2 } from 'lucide-react'
import { api, type Cell } from '@/lib/api'
import { ddlScript, draftId } from '@/lib/ddl'
import { cn } from '@/lib/cn'
import { ENGINES, type Dialect } from '@/lib/engines'
import { literal, qualified } from '@/lib/sql'
import { createStore } from '@/lib/store'
import { errorMessage, toast } from '@/lib/toast'
import {
  defaultFunctionName,
  dropTriggerStatement,
  editableLanguage,
  eventOptions,
  mysqlTriggerState,
  newTriggerDraft,
  pgTriggerState,
  singleEvent,
  timingOptions,
  triggerDraftFrom,
  triggerStatements,
  tsqlTriggerState,
  validateTrigger,
  type TriggerDraft,
  type TriggerEvent,
  type TriggerTarget
} from '@/lib/triggers'
import { connectionsStore, newQueryTab, refreshConnection } from '@/lib/workspace'
import { CodeEditor } from '@/components/editor/CodeEditor'
import {
  Badge,
  Button,
  ErrorText,
  Field,
  Input,
  Modal,
  Segmented,
  Select,
  Spinner,
  Toggle
} from '@/components/ui'

interface Request {
  connectionId: string
  database: string
  schema: string | null
  table: string
  isView: boolean
  /** Trigger to modify; null to create one */
  trigger: string | null
  /** Open straight on the drop confirmation */
  drop?: boolean
}

const triggerDesignerStore = createStore<Request | null>(null)

export function openTriggerDesigner(
  connectionId: string,
  database: string,
  schema: string | null,
  table: string,
  isView: boolean,
  trigger: string | null = null,
  drop = false
): void {
  triggerDesignerStore.set({ connectionId, database, schema, table, isView, trigger, drop })
}

const close = (): void => triggerDesignerStore.set(null)

export function TriggerDesignerHost(): React.JSX.Element | null {
  const request = triggerDesignerStore.use()
  if (!request) return null
  return (
    <TriggerDesigner
      key={`${request.connectionId}/${request.database}/${request.schema}.${request.table}/${request.trigger}/${request.drop}`}
      {...request}
    />
  )
}

/** Runs a catalog query on the metadata session and returns its rows. */
async function metaRows(connectionId: string, database: string, sql: string): Promise<Cell[][]> {
  const out = await api.execute(connectionId, '__meta', database, sql)
  if (out.error) throw new Error(out.error.message)
  return out.results[0]?.rows ?? []
}

const text = (cell: Cell | undefined): string => (typeof cell === 'string' ? cell : '')

interface PgFunction {
  schema: string
  name: string
  language: string
  source: string
}

interface TriggerMeta {
  columns: string[]
  /** The trigger's draft as it is now, or a new one */
  initial: TriggerDraft
  /** PostgreSQL functions returning trigger */
  functions: PgFunction[]
  /** Why the trigger can't be edited in the form; it can still be opened in the editor */
  unsupported: string | null
  definition: string | null
}

async function loadMeta(
  request: Request,
  dialect: Dialect,
  target: TriggerTarget
): Promise<TriggerMeta> {
  const { connectionId, database, schema, table, trigger } = request
  const run = (sql: string): Promise<Cell[][]> => metaRows(connectionId, database, sql)
  const [info, functionRows] = await Promise.all([
    api.table(connectionId, database, schema, table),
    dialect === 'postgres'
      ? run(
          "SELECT n.nspname, p.proname, l.lanname, p.prosrc FROM pg_proc p \
           JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang \
           WHERE p.prorettype = 'pg_catalog.trigger'::regtype AND p.pronargs = 0 \
             AND n.nspname NOT IN ('pg_catalog', 'information_schema') ORDER BY 1, 2"
        )
      : Promise.resolve([])
  ])
  const meta: TriggerMeta = {
    columns: info.columns.map((c) => c.name),
    initial: newTriggerDraft(dialect, target),
    functions: functionRows.map((r) => ({
      schema: text(r[0]),
      name: text(r[1]),
      language: text(r[2]),
      source: text(r[3])
    })),
    unsupported: null,
    definition: null
  }
  if (trigger === null) return meta
  const existing = info.triggers.find((t) => t.name === trigger)
  if (!existing) throw new Error(`The trigger ${trigger} no longer exists`)
  meta.definition = existing.definition
  if (dialect === 'postgres') {
    const [row] = await run(
      `SELECT pn.nspname, p.proname, l.lanname, p.prosrc, \
         (SELECT coalesce(json_agg(a.attname ORDER BY k.o), '[]') \
          FROM unnest(t.tgattr::int2[]) WITH ORDINALITY k(n, o) \
          JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attnum = k.n)::text, \
         pg_get_triggerdef(t.oid, true), CASE WHEN t.tgconstraint <> 0 THEN 'y' ELSE 'n' END \
       FROM pg_trigger t \
       JOIN pg_proc p ON p.oid = t.tgfoid \
       JOIN pg_namespace pn ON pn.oid = p.pronamespace \
       JOIN pg_language l ON l.oid = p.prolang \
       WHERE t.tgrelid = ${literal(dialect, qualified(dialect, { schema, name: table }))}::regclass \
         AND t.tgname = ${literal(dialect, trigger)}`
    )
    if (!row) throw new Error(`The trigger ${trigger} no longer exists`)
    if (text(row[6]) === 'y') {
      meta.unsupported = "Constraint triggers can't be edited here."
      return meta
    }
    meta.initial = triggerDraftFrom(
      pgTriggerState(existing, {
        functionSchema: text(row[0]),
        functionName: text(row[1]),
        language: text(row[2]),
        source: text(row[3]),
        updateColumns: JSON.parse(text(row[4]) || '[]') as string[],
        definition: text(row[5])
      })
    )
  } else if (dialect === 'mysql') {
    // The driver prefixes the stored body with a header ending in FOR EACH ROW
    const def = existing.definition ?? ''
    const at = def.indexOf('FOR EACH ROW\n')
    meta.initial = triggerDraftFrom(
      mysqlTriggerState(existing, at < 0 ? def : def.slice(at + 'FOR EACH ROW\n'.length))
    )
  } else {
    const state = tsqlTriggerState(existing)
    if (!state) meta.unsupported = "This trigger's definition couldn't be read."
    else meta.initial = triggerDraftFrom(state)
  }
  return meta
}

function TriggerDesigner(request: Request): React.JSX.Element {
  const { connectionId, database, schema, table, isView, trigger } = request
  const connection = connectionsStore.use().find((c) => c.id === connectionId)
  const dialect: Dialect = (connection && ENGINES[connection.engine].dialect) || 'postgres'
  const target = useMemo<TriggerTarget>(() => ({ schema, table, isView }), [schema, table, isView])
  const meta = useQuery({
    queryKey: ['conn', connectionId, 'triggerMeta', database, schema, table, trigger],
    queryFn: () => loadMeta(request, dialect, target),
    staleTime: 0
  })
  // Wait for the fresh fetch only; later refetches mustn't unmount the form and lose edits
  if (!meta.isFetchedAfterMount || !meta.data || (meta.data.unsupported && !request.drop)) {
    return (
      <Modal
        width="sm"
        title={trigger ?? 'New trigger'}
        onClose={close}
        footer={
          meta.data?.definition ? (
            <Button
              variant="secondary"
              onClick={() => {
                newQueryTab(connectionId, database, meta.data!.definition!)
                close()
              }}
            >
              <FilePlus2 className="size-3.5" /> Open in editor
            </Button>
          ) : undefined
        }
      >
        {meta.isError ? (
          <ErrorText error={meta.error} />
        ) : meta.data?.unsupported ? (
          <p className="text-[13px] text-fg">{meta.data.unsupported}</p>
        ) : (
          <div className="flex justify-center py-6">
            <Spinner className="size-5" />
          </div>
        )}
      </Modal>
    )
  }
  return <TriggerForm request={request} dialect={dialect} target={target} meta={meta.data} />
}

function TriggerForm({
  request,
  dialect,
  target,
  meta
}: {
  request: Request
  dialect: Dialect
  target: TriggerTarget
  meta: TriggerMeta
}): React.JSX.Element {
  const { connectionId, database } = request
  const connection = connectionsStore.use().find((c) => c.id === connectionId)
  const [draft, setDraft] = useState(meta.initial)
  const [dropping, setDropping] = useState(!!request.drop && !!request.trigger)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const original = draft.original
  const creating = !original
  const tableLabel = target.schema ? `${target.schema}.${target.table}` : target.table
  const patch = (change: Partial<TriggerDraft>): void => setDraft((d) => ({ ...d, ...change }))

  const statements = useMemo(
    () =>
      dropping
        ? [dropTriggerStatement(dialect, request.trigger!, target)]
        : triggerStatements(dialect, draft, target),
    [dropping, dialect, request.trigger, target, draft]
  )
  const script = ddlScript(dialect, statements)
  const problem = dropping ? null : validateTrigger(dialect, draft)

  const apply = async (): Promise<void> => {
    setRunning(true)
    setError(null)
    const session = `designer-${draftId()}`
    try {
      const out = await api.execute(connectionId, session, database, script)
      if (out.error) throw new Error(out.error.message)
      const name = draft.name.trim()
      toast(
        dropping
          ? `Dropped trigger ${request.trigger}`
          : creating
            ? `Created trigger ${name}`
            : `Updated trigger ${name}`
      )
      refreshConnection(connectionId)
      close()
    } catch (e) {
      setError(errorMessage(e))
      // XACT_ABORT doesn't roll back after a compile error, which leaves the transaction open
      if (dialect === 'tsql') {
        await api
          .execute(connectionId, session, database, 'IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;')
          .catch(() => undefined)
      }
    } finally {
      setRunning(false)
      void api.closeSession(connectionId, session).catch(() => undefined)
    }
  }

  const timings = timingOptions(dialect, target)
  const events = eventOptions(dialect, target)
  const toggleEvent = (e: TriggerEvent): void =>
    setDraft((d) => {
      if (singleEvent(dialect)) return { ...d, events: [e] }
      const next = d.events.includes(e) ? d.events.filter((x) => x !== e) : [...d.events, e]
      return { ...d, events: events.filter((x) => next.includes(x)) }
    })
  const functionKey = draft.newFunction ? '' : `${draft.functionSchema}.${draft.functionName}`
  const bodyEditable =
    dialect !== 'postgres' || draft.newFunction || editableLanguage(draft.language)
  const title = dropping
    ? `Drop trigger ${request.trigger}?`
    : creating
      ? 'New trigger'
      : `Edit trigger ${original!.name}`

  return (
    <Modal
      width="xl"
      title={title}
      description={<span className="font-mono">{tableLabel}</span>}
      icon={
        dropping ? (
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-danger/10 text-danger">
            <AlertTriangle className="size-4" />
          </span>
        ) : undefined
      }
      onClose={close}
      footer={
        <>
          {!creating && !dropping && (
            <Button
              variant="ghost"
              className="mr-auto hover:text-danger"
              onClick={() => setDropping(true)}
            >
              <Trash2 className="size-3.5" /> Drop trigger…
            </Button>
          )}
          {problem && <span className="mr-auto text-xs text-danger">{problem}</span>}
          {connection?.readOnly && <Badge tone="warning">read-only connection</Badge>}
          {dropping && !request.drop && (
            <Button variant="secondary" onClick={() => setDropping(false)}>
              Back
            </Button>
          )}
          <Button
            variant="secondary"
            disabled={!script || !!problem}
            onClick={() => {
              newQueryTab(connectionId, database, script)
              close()
            }}
          >
            <FilePlus2 className="size-3.5" /> Open in editor
          </Button>
          <Button
            variant={dropping ? 'danger' : 'primary'}
            disabled={!script || !!problem || running || connection?.readOnly}
            onClick={() => void apply()}
          >
            {running ? (
              <Spinner className="text-current" />
            ) : dropping ? (
              <Trash2 className="size-3.5" />
            ) : (
              <Save className="size-3.5" />
            )}
            {dropping ? 'Drop trigger' : creating ? 'Create trigger' : 'Apply changes'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {dropping ? (
          <p className="text-[13px] text-fg">
            <span className="font-mono text-bright">{request.trigger}</span> will stop running on{' '}
            <span className="font-mono text-bright">{tableLabel}</span>.
            {dialect === 'postgres' &&
              ' Its trigger function is kept, since other triggers may use it.'}
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Name" className="min-w-48 flex-1">
                <Input
                  mono
                  value={draft.name}
                  placeholder="trigger_name"
                  onChange={(e) => patch({ name: e.target.value })}
                />
              </Field>
              <Field label="Fires">
                <Segmented
                  className="h-8"
                  value={draft.timing}
                  options={timings.map((t) => ({ value: t, label: t.toLowerCase() }))}
                  onChange={(timing) => patch({ timing })}
                />
              </Field>
              {dialect === 'postgres' && (
                <Field label="Runs">
                  <Segmented
                    className="h-8"
                    value={draft.rowLevel ? 'row' : 'statement'}
                    options={[
                      { value: 'row', label: 'for each row' },
                      { value: 'statement', label: 'per statement' }
                    ]}
                    onChange={(v) => patch({ rowLevel: v === 'row' })}
                  />
                </Field>
              )}
            </div>
            <div className="flex flex-wrap items-start gap-6">
              <Field label={singleEvent(dialect) ? 'On' : 'On (any of)'}>
                <div className="flex gap-1.5">
                  {events.map((e) => (
                    <button
                      key={e}
                      type="button"
                      onClick={() => toggleEvent(e)}
                      className={cn(
                        'h-7 rounded-md px-2.5 text-xs ring-1 transition-colors ring-inset',
                        draft.events.includes(e)
                          ? 'bg-accent/10 text-accent ring-accent/40'
                          : 'text-muted ring-line-strong hover:text-bright'
                      )}
                    >
                      {e.toLowerCase()}
                    </button>
                  ))}
                </div>
              </Field>
              {dialect === 'postgres' && draft.events.includes('UPDATE') && !target.isView && (
                <Field
                  label="Only when these columns change"
                  className="min-w-0 flex-1"
                  hint={draft.updateColumns.length ? undefined : 'Any column'}
                >
                  <div className="flex flex-wrap gap-1">
                    {meta.columns.map((c) => {
                      const on = draft.updateColumns.includes(c)
                      return (
                        <button
                          key={c}
                          type="button"
                          onClick={() =>
                            patch({
                              updateColumns: on
                                ? draft.updateColumns.filter((x) => x !== c)
                                : meta.columns.filter(
                                    (x) => x === c || draft.updateColumns.includes(x)
                                  )
                            })
                          }
                          className={cn(
                            'h-6 rounded px-2 font-mono text-[11px] ring-1 ring-inset',
                            on
                              ? 'bg-accent/10 text-accent ring-accent/40'
                              : 'text-muted ring-line hover:text-bright'
                          )}
                        >
                          {c}
                        </button>
                      )
                    })}
                  </div>
                </Field>
              )}
            </div>
            {dialect === 'postgres' && (
              <>
                {draft.timing !== 'INSTEAD OF' && (
                  <Field label="When (optional)">
                    <Input
                      mono
                      value={draft.condition}
                      placeholder="OLD.status IS DISTINCT FROM NEW.status"
                      onChange={(e) => patch({ condition: e.target.value })}
                    />
                  </Field>
                )}
                <div className="flex gap-3">
                  <Field label="Function" className="flex-1">
                    <Select
                      selectClassName="font-mono text-xs"
                      value={functionKey}
                      onChange={(e) => {
                        const fn = meta.functions.find(
                          (f) => `${f.schema}.${f.name}` === e.target.value
                        )
                        if (!fn) {
                          const fresh = newTriggerDraft(dialect, target)
                          patch({
                            newFunction: true,
                            functionSchema: target.schema ?? '',
                            functionName: '',
                            language: 'plpgsql',
                            body: fresh.body,
                            loadedBody: ''
                          })
                        } else {
                          patch({
                            newFunction: false,
                            functionSchema: fn.schema,
                            functionName: fn.name,
                            language: fn.language,
                            body: fn.source,
                            loadedBody: fn.source
                          })
                        }
                      }}
                    >
                      <option value="">New function…</option>
                      {meta.functions.map((f) => (
                        <option key={`${f.schema}.${f.name}`} value={`${f.schema}.${f.name}`}>
                          {f.schema}.{f.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  {draft.newFunction && (
                    <Field label="Function name" className="flex-1">
                      <Input
                        mono
                        value={draft.functionName}
                        placeholder={defaultFunctionName(draft, target)}
                        onChange={(e) => patch({ functionName: e.target.value })}
                      />
                    </Field>
                  )}
                  <Field label="Arguments" className="w-48" hint="Read as TG_ARGV">
                    <Input
                      mono
                      value={draft.functionArgs}
                      placeholder="'audit'"
                      onChange={(e) => patch({ functionArgs: e.target.value })}
                    />
                  </Field>
                </div>
              </>
            )}
            {dialect !== 'mysql' && !(dialect === 'postgres' && target.isView) && (
              <Toggle
                checked={draft.enabled}
                onChange={(enabled) => patch({ enabled })}
                label="Enabled"
                description="A disabled trigger stays defined but doesn't fire"
              />
            )}
            <div>
              <p className="mb-1.5 text-[11px] font-medium text-muted">
                {dialect === 'postgres'
                  ? `Function body (${draft.newFunction ? 'plpgsql' : draft.language})`
                  : 'Trigger body'}
              </p>
              <div className="h-48 overflow-hidden rounded-lg border border-line bg-canvas">
                <CodeEditor
                  value={draft.body}
                  onChange={(body) => patch({ body })}
                  language={{ kind: 'sql', dialect }}
                  readOnly={!bodyEditable}
                  className="h-full"
                  fontSize={12}
                />
              </div>
              <p className="mt-1 text-[11px] text-faint">
                {dialect === 'postgres'
                  ? !bodyEditable
                    ? `${draft.language} functions can't be edited here.`
                    : !draft.newFunction
                      ? `Editing the body replaces ${draft.functionName} for every trigger that uses it.`
                      : 'NEW and OLD hold the row; return NEW (or NULL to skip it) from BEFORE row triggers.'
                  : dialect === 'mysql'
                    ? 'Use BEGIN … END for more than one statement. NEW and OLD hold the row.'
                    : 'The inserted and deleted tables hold the affected rows.'}
              </p>
            </div>
            {dialect === 'mysql' && !creating && (
              <p className="text-xs text-warn">
                MySQL can&apos;t alter a trigger, so applying changes drops it and creates it again,
                with you as its definer.
              </p>
            )}
          </>
        )}
        {error && (
          <div className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2">
            <ErrorText error={error} />
          </div>
        )}
        <div>
          <p className="mb-1.5 text-[11px] font-medium text-muted">Statements</p>
          <div className="h-40 overflow-hidden rounded-lg border border-line bg-canvas">
            <CodeEditor
              value={script || '-- No changes'}
              language={{ kind: 'sql', dialect }}
              readOnly
              lineNumbers={false}
              className="h-full"
              fontSize={12}
            />
          </div>
        </div>
      </div>
    </Modal>
  )
}
