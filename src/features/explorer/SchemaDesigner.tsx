import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, FilePlus2, Save, Trash2 } from 'lucide-react'
import { api, type Cell, type DbObject } from '@/lib/api'
import {
  canChangeSchemaOwner,
  canRenameSchema,
  ddlScript,
  draftId,
  dropSchemaStatement,
  newSchemaDraft,
  schemaDraftFrom,
  schemaStatements,
  validateSchema,
  type SchemaDraft,
  type SchemaState
} from '@/lib/ddl'
import { ENGINES, type Dialect } from '@/lib/engines'
import { plural } from '@/lib/format'
import { queries } from '@/lib/queries'
import { literal } from '@/lib/sql'
import { createStore } from '@/lib/store'
import { errorMessage, toast } from '@/lib/toast'
import { connectionsStore, newQueryTab, refreshConnection } from '@/lib/workspace'
import { CodeEditor } from '@/components/editor/CodeEditor'
import {
  Badge,
  Button,
  ErrorText,
  Field,
  Input,
  Modal,
  Select,
  Spinner,
  Textarea,
  Toggle
} from '@/components/ui'

interface Request {
  connectionId: string
  /** Database the statements run in; for MySQL, the database being designed (or '' to create one) */
  database: string
  /** Schema to modify (the database itself on MySQL); null to create one */
  schema: string | null
  /** Open straight on the drop confirmation */
  drop?: boolean
}

const schemaDesignerStore = createStore<Request | null>(null)

export function openSchemaDesigner(
  connectionId: string,
  database: string,
  schema: string | null = null,
  drop = false
): void {
  schemaDesignerStore.set({ connectionId, database, schema, drop })
}

const close = (): void => schemaDesignerStore.set(null)

export function SchemaDesignerHost(): React.JSX.Element | null {
  const request = schemaDesignerStore.use()
  if (!request) return null
  return (
    <SchemaDesigner
      key={`${request.connectionId}/${request.database}/${request.schema}/${request.drop}`}
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

interface SchemaMeta {
  /** The schema as it is now; null when creating */
  state: SchemaState | null
  /** Roles / principals that can own a schema */
  owners: string[]
  /** MySQL character sets with their collations */
  charsets: { name: string; collations: string[] }[]
}

async function loadMeta(
  connectionId: string,
  database: string,
  dialect: Dialect,
  schema: string | null
): Promise<SchemaMeta> {
  const run = (sql: string): Promise<Cell[][]> => metaRows(connectionId, database, sql)
  const empty: SchemaState = {
    name: schema ?? '',
    owner: '',
    comment: '',
    charset: '',
    collation: ''
  }
  if (dialect === 'mysql') {
    const [collations, current] = await Promise.all([
      run(
        'SELECT character_set_name, collation_name FROM information_schema.collations ORDER BY character_set_name, collation_name'
      ),
      schema === null
        ? Promise.resolve([])
        : run(
            `SELECT default_character_set_name, default_collation_name FROM information_schema.schemata WHERE schema_name = ${literal(dialect, schema)}`
          )
    ])
    const charsets = new Map<string, string[]>()
    for (const [charset, collation] of collations) {
      const list = charsets.get(text(charset)) ?? []
      list.push(text(collation))
      charsets.set(text(charset), list)
    }
    return {
      state: current[0]
        ? { ...empty, charset: text(current[0][0]), collation: text(current[0][1]) }
        : null,
      owners: [],
      charsets: [...charsets].map(([name, list]) => ({ name, collations: list }))
    }
  }
  if (dialect === 'postgres') {
    const [roles, current] = await Promise.all([
      run("SELECT rolname FROM pg_roles WHERE rolname !~ '^pg_' ORDER BY 1"),
      schema === null
        ? Promise.resolve([])
        : run(
            `SELECT pg_get_userbyid(nspowner), coalesce(obj_description(oid, 'pg_namespace'), '') FROM pg_namespace WHERE nspname = ${literal(dialect, schema)}`
          )
    ])
    return {
      state: current[0]
        ? { ...empty, owner: text(current[0][0]), comment: text(current[0][1]) }
        : null,
      owners: roles.map((r) => text(r[0])),
      charsets: []
    }
  }
  const [principals, current] = await Promise.all([
    run(
      "SELECT name FROM sys.database_principals WHERE type IN ('S','U','G','R','E','X','A') AND name NOT LIKE '##%' AND name NOT IN ('public', 'sys', 'INFORMATION_SCHEMA') ORDER BY name"
    ),
    schema === null
      ? Promise.resolve([])
      : run(
          `SELECT USER_NAME(principal_id) FROM sys.schemas WHERE name = ${literal(dialect, schema)}`
        )
  ])
  return {
    state: current[0] ? { ...empty, owner: text(current[0][0]) } : null,
    owners: principals.map((p) => text(p[0])),
    charsets: []
  }
}

function SchemaDesigner(request: Request): React.JSX.Element {
  const { connectionId, database, schema } = request
  const connection = connectionsStore.use().find((c) => c.id === connectionId)
  const dialect: Dialect = (connection && ENGINES[connection.engine].dialect) || 'postgres'
  const noun = dialect === 'mysql' ? 'database' : 'schema'
  const meta = useQuery({
    queryKey: ['conn', connectionId, 'schemaMeta', database, schema],
    queryFn: () => loadMeta(connectionId, database, dialect, schema),
    staleTime: 0
  })
  // Wait for the fresh fetch only; later refetches mustn't unmount the form and lose edits
  if (!meta.isFetchedAfterMount || !meta.data || (schema !== null && !meta.data.state)) {
    return (
      <Modal width="sm" title={schema ?? `New ${noun}`} onClose={close}>
        {meta.isError ? (
          <ErrorText error={meta.error} />
        ) : meta.data && schema !== null && !meta.data.state ? (
          <ErrorText error={`The ${noun} ${schema} no longer exists`} />
        ) : (
          <div className="flex justify-center py-6">
            <Spinner className="size-5" />
          </div>
        )}
      </Modal>
    )
  }
  return (
    <SchemaForm
      request={request}
      dialect={dialect}
      noun={noun}
      meta={meta.data}
      initial={meta.data.state ? schemaDraftFrom(meta.data.state) : newSchemaDraft()}
    />
  )
}

const KIND_LABELS: Partial<Record<DbObject['kind'], string>> = {
  table: 'table',
  foreign_table: 'foreign table',
  view: 'view',
  materialized_view: 'materialized view',
  function: 'function',
  procedure: 'procedure',
  sequence: 'sequence',
  synonym: 'synonym'
}

function SchemaForm({
  request,
  dialect,
  noun,
  meta,
  initial
}: {
  request: Request
  dialect: Dialect
  noun: string
  meta: SchemaMeta
  initial: SchemaDraft
}): React.JSX.Element {
  const { connectionId, database } = request
  const connection = connectionsStore.use().find((c) => c.id === connectionId)
  const babelfish = connection?.engine === 'babelfish'
  const [draft, setDraft] = useState(initial)
  const [dropping, setDropping] = useState(!!request.drop && !!initial.original)
  const [cascade, setCascade] = useState(false)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const original = draft.original
  const creating = !original

  // What the schema contains, so dropping it is an informed decision
  const objects = useQuery({
    ...queries.objects(
      connectionId,
      dialect === 'mysql' ? (original?.name ?? '') : database,
      dialect === 'postgres' ? (original?.name ?? null) : null
    ),
    enabled: !creating
  })
  const schemas = useQuery({
    ...queries.schemas(connectionId, database),
    enabled: dialect === 'tsql' && !creating
  })
  const contents = useMemo(() => {
    const inSchema = (objects.data ?? []).filter(
      (o) => dialect !== 'tsql' || o.schema === original?.name
    )
    const counts = new Map<string, number>()
    for (const o of inSchema) {
      const label = KIND_LABELS[o.kind] ?? o.kind
      counts.set(label, (counts.get(label) ?? 0) + 1)
    }
    return { total: inSchema.length, summary: [...counts].map(([k, n]) => plural(n, k)).join(', ') }
  }, [objects.data, dialect, original?.name])

  const statements = useMemo(
    () =>
      dropping && original
        ? [dropSchemaStatement(dialect, original.name, cascade)]
        : schemaStatements(dialect, draft, { babelfish }),
    [dropping, original, dialect, cascade, draft, babelfish]
  )
  const script = ddlScript(dialect, statements)
  const problem = dropping ? null : validateSchema(draft)

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
          ? `Dropped ${original!.name}`
          : creating
            ? `Created ${noun} ${name}`
            : `Updated ${name}`
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

  const ownerEditable = creating || canChangeSchemaOwner(dialect, { babelfish })
  const charset = meta.charsets.find((c) => c.name === draft.charset)
  const title = dropping
    ? `Drop ${noun} ${original!.name}?`
    : creating
      ? `New ${noun}`
      : `Edit ${noun} ${original!.name}`

  return (
    <Modal
      width="lg"
      title={title}
      description={dialect === 'mysql' ? undefined : <span className="font-mono">{database}</span>}
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
              <Trash2 className="size-3.5" /> Drop {noun}…
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
            {dropping ? `Drop ${noun}` : creating ? `Create ${noun}` : 'Apply changes'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {dropping ? (
          <div className="space-y-3 text-[13px] text-fg">
            <p>
              {objects.isPending ? (
                'Checking what it contains…'
              ) : contents.total ? (
                <>
                  <span className="font-mono text-bright">{original!.name}</span> contains{' '}
                  {contents.summary}.
                </>
              ) : (
                <>
                  <span className="font-mono text-bright">{original!.name}</span> is empty.
                </>
              )}
            </p>
            {dialect === 'mysql' ? (
              <p className="text-danger">
                Dropping a database permanently deletes every table in it and all of their data.
              </p>
            ) : dialect === 'postgres' ? (
              <>
                <Toggle
                  checked={cascade}
                  onChange={setCascade}
                  label="Drop everything in it (CASCADE)"
                  description="Also drops the schema's objects and anything elsewhere that depends on them"
                />
                {!cascade && contents.total > 0 && (
                  <p className="text-xs text-warn">
                    Without CASCADE the drop fails while the schema has objects.
                  </p>
                )}
              </>
            ) : (
              contents.total > 0 && (
                <p className="text-xs text-warn">
                  SQL Server only drops empty schemas; drop or move its objects first.
                </p>
              )
            )}
          </div>
        ) : (
          <>
            <div className="flex gap-3">
              <Field
                label="Name"
                className="flex-1"
                hint={
                  !creating && !canRenameSchema(dialect)
                    ? `${dialect === 'mysql' ? 'MySQL' : 'SQL Server'} can't rename ${noun}s`
                    : undefined
                }
              >
                {dialect === 'tsql' && !creating ? (
                  // Schemas aren't nodes in the SQL Server tree, so this picks which one to edit
                  <Select
                    selectClassName="font-mono text-xs"
                    value={original!.name}
                    onChange={(e) => openSchemaDesigner(connectionId, database, e.target.value)}
                  >
                    {[
                      ...new Set([
                        original!.name,
                        ...(schemas.data?.filter((s) => !s.isSystem).map((s) => s.name) ?? [])
                      ])
                    ].map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input
                    mono
                    value={draft.name}
                    placeholder={dialect === 'mysql' ? 'database_name' : 'schema_name'}
                    disabled={!creating && !canRenameSchema(dialect)}
                    onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                  />
                )}
              </Field>
              {dialect !== 'mysql' && (
                <Field
                  label="Owner"
                  className="w-56"
                  hint={
                    !ownerEditable ? "Babelfish can't change an existing schema's owner" : undefined
                  }
                >
                  <Select
                    value={draft.owner}
                    disabled={!ownerEditable}
                    onChange={(e) => setDraft((d) => ({ ...d, owner: e.target.value }))}
                  >
                    {creating && <option value="">Current user</option>}
                    {[...new Set([...(draft.owner ? [draft.owner] : []), ...meta.owners])].map(
                      (o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      )
                    )}
                  </Select>
                </Field>
              )}
            </div>
            {dialect === 'postgres' && (
              <Field label="Comment">
                <Textarea
                  className="min-h-16"
                  value={draft.comment}
                  onChange={(e) => setDraft((d) => ({ ...d, comment: e.target.value }))}
                />
              </Field>
            )}
            {dialect === 'mysql' && (
              <div className="flex gap-3">
                <Field label="Character set" className="flex-1">
                  <Select
                    value={draft.charset}
                    onChange={(e) =>
                      // Each collation belongs to one character set; reset to its default
                      setDraft((d) => ({ ...d, charset: e.target.value, collation: '' }))
                    }
                  >
                    {creating && <option value="">Server default</option>}
                    {meta.charsets.map((c) => (
                      <option key={c.name} value={c.name}>
                        {c.name}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field
                  label="Collation"
                  className="flex-1"
                  hint={
                    !creating
                      ? 'Applies to tables created afterwards; existing ones keep theirs'
                      : undefined
                  }
                >
                  <Select
                    value={draft.collation}
                    disabled={!draft.charset}
                    onChange={(e) => setDraft((d) => ({ ...d, collation: e.target.value }))}
                  >
                    <option value="">Default for the character set</option>
                    {charset?.collations.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            )}
            {!creating && (
              <p className="text-xs text-muted">
                {objects.isPending
                  ? 'Loading contents…'
                  : contents.total
                    ? `Contains ${contents.summary}.`
                    : `This ${noun} is empty.`}
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
          <p className="mb-1.5 text-[11px] font-medium text-muted">Statement</p>
          <div className="h-32 overflow-hidden rounded-lg border border-line bg-canvas">
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
