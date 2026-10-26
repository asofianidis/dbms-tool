import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, Database, FilePlus2, Pencil, Plus, Trash2 } from 'lucide-react'
import { api, type Cell } from '@/lib/api'
import {
  createDatabaseStatements,
  databaseNameProblem,
  dropDatabaseStatements,
  emptyDatabase,
  isDatabaseEngine,
  maintenanceDatabase,
  pgMajorVersion,
  renameDatabaseStatements,
  type DatabaseEngine,
  type NewDatabase
} from '@/lib/databases'
import { draftId } from '@/lib/ddl'
import { formatBytes } from '@/lib/format'
import { connectedInfo } from '@/lib/mariadb'
import { queries } from '@/lib/queries'
import { createStore } from '@/lib/store'
import { errorMessage, toast } from '@/lib/toast'
import {
  connectionsStore,
  defaultDatabase,
  newQueryTab,
  refreshConnection,
  statusStore,
  tabsStore,
  updateTab
} from '@/lib/workspace'
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

type Mode = 'create' | 'rename' | 'drop'

interface Request {
  connectionId: string
  mode: Mode
  /** The database to rename or drop; null when creating */
  database: string | null
}

const requestStore = createStore<Request | null>(null)

/** Creates, renames or drops a PostgreSQL / SQL Server / Babelfish database. */
export function openDatabaseDesigner(
  connectionId: string,
  mode: Mode = 'create',
  database: string | null = null
): void {
  requestStore.set({ connectionId, mode, database })
}

const close = (): void => requestStore.set(null)

export function DatabaseDesignerHost(): React.JSX.Element | null {
  const request = requestStore.use()
  const connection = connectionsStore.use().find((c) => c.id === request?.connectionId)
  if (!request || !connection || !isDatabaseEngine(connection.engine)) return null
  return (
    <DatabaseDesigner
      key={`${request.connectionId}/${request.mode}/${request.database}`}
      request={request}
      engine={connection.engine}
    />
  )
}

const text = (cell: Cell | undefined): string => (typeof cell === 'string' ? cell : '')

const ENCODINGS = ['UTF8', 'LATIN1', 'LATIN9', 'WIN1252', 'SQL_ASCII', 'EUC_JP', 'EUC_KR']

/** Roles and template databases for a PostgreSQL CREATE DATABASE. */
async function loadPgOptions(
  connectionId: string,
  database: string
): Promise<{ roles: string[]; templates: string[]; user: string }> {
  const out = await api.execute(
    connectionId,
    '__meta',
    database,
    "SELECT rolname, 'role' FROM pg_roles WHERE rolname !~ '^pg_' " +
      "UNION ALL SELECT datname, 'db' FROM pg_database WHERE datallowconn OR datistemplate " +
      "UNION ALL SELECT current_user, 'me' ORDER BY 2, 1"
  )
  if (out.error) throw new Error(out.error.message)
  const rows = out.results[0]?.rows ?? []
  const of = (kind: string): string[] => rows.filter((r) => r[1] === kind).map((r) => text(r[0]))
  return { roles: of('role'), templates: of('db'), user: of('me')[0] ?? '' }
}

function DatabaseDesigner({
  request,
  engine
}: {
  request: Request
  engine: DatabaseEngine
}): React.JSX.Element {
  const { connectionId, mode } = request
  const target = request.database
  const connection = connectionsStore.use().find((c) => c.id === connectionId)
  const info = connectedInfo(statusStore.use()[connectionId])
  const postgres = engine === 'postgres'
  const runIn = maintenanceDatabase(engine, target, defaultDatabase(connectionId))

  const databases = useQuery(queries.databases(connectionId))
  const existing = (databases.data ?? []).map((d) => d.name)
  const pgOptions = useQuery({
    queryKey: ['conn', connectionId, 'database-options', runIn],
    queryFn: () => loadPgOptions(connectionId, runIn),
    enabled: postgres && mode === 'create',
    staleTime: 0
  })

  const [db, setDb] = useState<NewDatabase>(emptyDatabase)
  const [newName, setNewName] = useState(target ?? '')
  const [force, setForce] = useState(true)
  const [typed, setTyped] = useState('')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = (patch: Partial<NewDatabase>): void => setDb((d) => ({ ...d, ...patch }))

  const others = existing.filter((n) => n !== target)
  let statements: string[] = []
  let problem: string | null = null
  try {
    if (mode === 'create') {
      problem = databaseNameProblem(engine, db.name, existing)
      if (!problem) statements = createDatabaseStatements(engine, db)
    } else if (mode === 'rename') {
      problem =
        newName.trim() === target
          ? 'Enter a new name'
          : databaseNameProblem(engine, newName, others)
      if (!problem) statements = renameDatabaseStatements(engine, target!, newName, force)
    } else {
      problem = typed === target ? null : `Type ${target} to confirm`
      statements = dropDatabaseStatements(
        engine,
        target!,
        force,
        info ? pgMajorVersion(info.version) : null
      )
    }
  } catch (e) {
    problem = errorMessage(e)
  }
  const script = statements.map((s) => `${s};`).join('\n')
  const size = (databases.data ?? []).find((d) => d.name === target)?.sizeBytes
  const isDefault = !!target && connection?.database === target

  const apply = async (): Promise<void> => {
    setRunning(true)
    setError(null)
    const session = `database-${draftId()}`
    const exec = async (sql: string): Promise<void> => {
      const out = await api.execute(connectionId, session, runIn, sql)
      if (out.error) throw new Error(out.error.message)
    }
    try {
      // One at a time: PostgreSQL can't run CREATE DATABASE inside a transaction block
      for (const s of statements) await exec(s)
      if (mode === 'rename') {
        const renamed = newName.trim()
        for (const tab of tabsStore.get().tabs)
          if ('database' in tab && tab.connectionId === connectionId && tab.database === target)
            updateTab(tab.id, { database: renamed })
        toast(`Renamed ${target} to ${renamed}`)
      } else toast(mode === 'create' ? `Created ${db.name.trim()}` : `Dropped ${target}`)
      refreshConnection(connectionId)
      close()
    } catch (e) {
      setError(errorMessage(e))
      // Don't leave a SQL Server database stuck in single-user mode
      if (engine === 'mssql' && force && mode !== 'create') {
        for (const name of new Set([target!, newName.trim()]))
          await exec(`ALTER DATABASE [${name.replace(/]/g, ']]')}] SET MULTI_USER`).catch(
            () => undefined
          )
      }
    } finally {
      setRunning(false)
      void api.closeSession(connectionId, session).catch(() => undefined)
    }
  }

  const title =
    mode === 'create'
      ? 'New database'
      : mode === 'rename'
        ? `Rename ${target}`
        : `Drop database ${target}?`
  const forceLabel = postgres
    ? 'Disconnect other sessions first'
    : 'Roll back and disconnect other sessions first'
  const forceHint =
    mode === 'drop'
      ? `${postgres ? 'PostgreSQL' : 'SQL Server'} won't drop a database anyone is connected to, including this app's other tabs.`
      : `${postgres ? 'PostgreSQL' : 'SQL Server'} won't rename a database anyone is connected to, including this app's other tabs.`

  return (
    <Modal
      width={mode === 'create' ? 'lg' : 'md'}
      title={title}
      description={<span className="font-mono">{connection?.name}</span>}
      icon={
        mode === 'drop' ? (
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-danger/10 text-danger">
            <AlertTriangle className="size-4" />
          </span>
        ) : (
          <Database className="mt-0.5 size-4 text-accent" />
        )
      }
      onClose={close}
      footer={
        <>
          <div className="mr-auto min-w-0 truncate text-xs text-danger">
            {(mode !== 'drop' || typed) && problem}
          </div>
          {connection?.readOnly && <Badge tone="warning">read-only connection</Badge>}
          <Button
            variant="secondary"
            disabled={!script || (mode !== 'drop' && !!problem)}
            onClick={() => {
              newQueryTab(connectionId, runIn, script, { title: title.replace(/\?$/, '') })
              close()
            }}
          >
            <FilePlus2 className="size-3.5" /> Open in editor
          </Button>
          <Button
            variant={mode === 'drop' ? 'danger' : 'primary'}
            disabled={!!problem || running || connection?.readOnly}
            onClick={() => void apply()}
          >
            {running ? (
              <Spinner className="text-current" />
            ) : mode === 'drop' ? (
              <Trash2 className="size-3.5" />
            ) : mode === 'rename' ? (
              <Pencil className="size-3.5" />
            ) : (
              <Plus className="size-3.5" />
            )}
            {mode === 'create' ? 'Create database' : mode === 'rename' ? 'Rename' : 'Drop database'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {mode === 'create' && (
          <>
            <Field label="Name">
              <Input
                mono
                value={db.name}
                placeholder="my_app"
                onChange={(e) => set({ name: e.target.value })}
              />
            </Field>
            {postgres && (
              <>
                <div className="grid grid-cols-3 gap-3">
                  <Field label="Owner">
                    <Select value={db.owner} onChange={(e) => set({ owner: e.target.value })}>
                      <option value="">
                        {pgOptions.data?.user ? `${pgOptions.data.user} (you)` : 'You'}
                      </option>
                      {pgOptions.data?.roles
                        .filter((r) => r !== pgOptions.data.user)
                        .map((r) => (
                          <option key={r}>{r}</option>
                        ))}
                    </Select>
                  </Field>
                  <Field
                    label="Template"
                    hint={
                      db.template && !/^template[01]$/.test(db.template)
                        ? 'Copies its schema and data'
                        : undefined
                    }
                  >
                    <Select value={db.template} onChange={(e) => set({ template: e.target.value })}>
                      <option value="">template1 (default)</option>
                      {pgOptions.data?.templates
                        .filter((t) => t !== 'template1')
                        .map((t) => (
                          <option key={t} value={t}>
                            {t === 'template0' ? 'template0 (pristine)' : `${t} (copy)`}
                          </option>
                        ))}
                    </Select>
                  </Field>
                  <Field
                    label="Encoding"
                    hint={
                      db.encoding && db.template !== 'template0'
                        ? "Needs template0 if template1's encoding differs"
                        : undefined
                    }
                  >
                    <Select value={db.encoding} onChange={(e) => set({ encoding: e.target.value })}>
                      <option value="">Template's (usually UTF8)</option>
                      {ENCODINGS.map((e) => (
                        <option key={e}>{e}</option>
                      ))}
                    </Select>
                  </Field>
                </div>
                <Field label="Comment">
                  <Textarea
                    rows={2}
                    value={db.comment}
                    onChange={(e) => set({ comment: e.target.value })}
                    placeholder="Optional"
                  />
                </Field>
                {pgOptions.isError && <ErrorText error={pgOptions.error} />}
              </>
            )}
            {engine === 'mssql' && (
              <Field label="Collation" hint="Leave empty for the server's default collation">
                <Input
                  mono
                  value={db.collation}
                  placeholder="e.g. Latin1_General_100_CI_AS_SC_UTF8"
                  onChange={(e) => set({ collation: e.target.value })}
                />
              </Field>
            )}
          </>
        )}

        {mode === 'rename' && (
          <Field label="New name">
            <Input mono value={newName} onChange={(e) => setNewName(e.target.value)} />
          </Field>
        )}

        {mode === 'drop' && (
          <>
            <p className="text-sm text-fg">
              Every schema, table and row in <span className="font-mono">{target}</span>
              {typeof size === 'number' ? ` (${formatBytes(size)})` : ''} is deleted for good. This
              can't be undone.
            </p>
            <Field label={<>Type {target} to confirm</>}>
              <Input mono value={typed} onChange={(e) => setTyped(e.target.value)} />
            </Field>
          </>
        )}

        {mode !== 'create' && engine !== 'babelfish' && (
          <Toggle checked={force} onChange={setForce} label={forceLabel} description={forceHint} />
        )}
        {isDefault && (
          <p className="flex gap-1.5 text-xs text-warn">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            The connection opens this database by default; update its settings afterwards.
          </p>
        )}

        {script && (
          <pre className="max-h-40 overflow-auto rounded-md bg-canvas px-3 py-2 font-mono text-[11.5px] whitespace-pre-wrap text-muted select-text">
            {script}
          </pre>
        )}
        {error && (
          <div className="rounded-lg border border-danger/30 bg-danger/5 px-3 py-2">
            <ErrorText error={error} />
          </div>
        )}
      </div>
    </Modal>
  )
}
